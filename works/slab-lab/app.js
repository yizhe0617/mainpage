/* ═══════════════════════════════════════════════════════════════════════════
   SLAB·LAB 牌局研究室 — 前端主邏輯(vanilla JS,無 build step)
   資料契約 = crates/slab-cli/src/protocol.rs:
     POST /api          {cmd:"navigate"|"node"|"strategy"|"values"|"lock"|"unlock"|...}
     POST /api/solve    {spot: SpotConfig, gpu: bool}(背景解算)
     POST /api/resolve  {iterations, target_exploitability, gpu}(鎖定重解;GPU kernel 鎖定手凍結)
     GET  /api/status   {phase, iter, total, exploitability, gpu, result|error}
     GET  /api/preflop  charts.json(9 人桌翻前圖表)
   牌索引:Card::index = rank*4 + suit(rank 2=0..A=12;suit c=0,d=1,h=2,s=3)
   導覽:line strip(GTOW 逐層動作列)+ tree view(Pio 可展開樹)共用 nodeMeta 快取
   (key = history.join(','),內容 = 節點資訊 + 各動作聚合頻率;solve/resolve 後清空)。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── 牌與常數 ──────────────────────────────────────────────────────────── */
const RANKS = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"]; // 顯示序(高→低)
const RANK_VAL = {2:0,3:1,4:2,5:3,6:4,7:5,8:6,9:7,T:8,J:9,Q:10,K:11,A:12};
const SUITS = [
  { ch:"s", sym:"♠", cls:"suit-s" },
  { ch:"h", sym:"♥", cls:"suit-h" },
  { ch:"d", sym:"♦", cls:"suit-d" },
  { ch:"c", sym:"♣", cls:"suit-c" },
];
const SUIT_VAL = { c:0, d:1, h:2, s:3 };
const SUIT_OF = ["c","d","h","s"];
const SUIT_SYM = { c:"♣", d:"♦", h:"♥", s:"♠" };

const cardIdx = (r, s) => RANK_VAL[r] * 4 + SUIT_VAL[s];
const idxRank = i => "23456789TJQKA"[i >> 2];
const idxSuit = i => SUIT_OF[i & 3];
const cardStr = i => idxRank(i) + idxSuit(i);

/* 動作色(style-spec §4 色盤;JS 需 hex 畫 bar 段) */
const C = {
  fold:"#46555f", check:"#2f9e8f", call:"#57b06a",
  bet:"#d99a3a", raise:"#d96b3a", allin:"#c64a44",
  limp:"#4fa3a0", bluff:"#5b8fd9", brass:"#d4a548",
};

/* ── API ───────────────────────────────────────────────────────────────── */
async function api(req) {
  const r = await fetch("/api", { method:"POST", body: JSON.stringify(req) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "api error");
  return j.result;
}
async function apiPost(path, body) {
  const r = await fetch(path, { method:"POST", body: JSON.stringify(body) });
  return r.json();
}
async function apiStatus() { return (await fetch("/api/status")).json(); }

/* ── 全域狀態 ──────────────────────────────────────────────────────────── */
const S = {
  seats: [],            // 已點座位 id 順序(最多 2)
  board: [],            // 牌 index(3..5 張)
  solved: false,
  node: null,           // NodeInfo(當前)
  strategy: null,       // StrategyResult(決策節點)
  values: { 0:null, 1:null },
  view: "strategy",
  valPlayer: 0,
  selLabel: null,
  meta: new Map(),      // historyKey → 節點摘要(line strip / tree view 共用;解算後清空)
  treeOpen: new Set(),  // 已展開的樹節點 key
  lockEditMode: false,
  lockSel: new Set(),   // 鎖定編輯:選中的 13×13 label
  pf: { charts:null, seat:null, mode:"RFI", node:null },
};
const hkey = hist => hist.join(",");

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const fmtPct = x => (x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1) + "%";

function setEngine(state, text) {
  $("engineDot").className = "dot " + state;
  $("engineText").textContent = text;
}

/* ═══════════════ 分頁 ═══════════════ */
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(x => {
    x.classList.toggle("active", x === b);
    x.setAttribute("aria-selected", x === b ? "true" : "false");
  });
  $("tab-postflop").hidden = b.dataset.tab !== "postflop";
  $("tab-preflop").hidden = b.dataset.tab !== "preflop";
  if (b.dataset.tab === "preflop" && !S.pf.charts) loadPreflop();
}));

/* ═══════════════ 座位選擇(6-max,postflop 順序決定 OOP/IP)═══════════════ */
const SEATS6 = [
  { id:"UTG", ang:270 }, { id:"HJ", ang:330 }, { id:"CO", ang:30 },
  { id:"BTN", ang:90 },  { id:"SB", ang:150 }, { id:"BB", ang:210 },
];
const POSTFLOP_ORDER = { SB:0, BB:1, UTG:2, HJ:3, CO:4, BTN:5 }; // 小 = 先行動 = OOP

const OPEN_RANGES = {
  UTG: "77+,ATs+,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo",
  HJ:  "66+,A9s+,KTs+,QTs+,J9s+,T9s,98s,87s,ATo+,KJo+,QJo",
  CO:  "44+,A4s+,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,65s,ATo+,KTo+,QTo+,JTo",
  BTN: "22+,A2s+,K5s+,Q7s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,A7o+,K9o+,Q9o+,J9o+,T8o+,98o",
  SB:  "22+,A2s+,K6s+,Q8s+,J8s+,T7s+,97s+,86s+,75s+,65s,A8o+,KTo+,QTo+,JTo,T9o",
  BB:  "22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,75s+,64s+,53s+,A2o+,K8o+,Q9o+,J9o+,T8o+,98o",
};
const BB_DEFEND = "66-22,A8s-A2s,K9s-K5s,Q9s-Q6s,J9s-J7s,T9s-T7s,98s-96s,87s-85s,76s-74s,65s,54s,ATo-A7o,KJo-K9o,QTo-Q9o,JTo-J9o,T9o,98o";
const CALLER_GENERIC = "99-22,AJs-A9s,KTs+,QTs+,JTs,T9s,98s,87s,76s,AQo-AJo,KQo";
const THREEBET_POLAR = "QQ+,AKs,AKo,AQs,A5s-A4s,KQs,76s,65s";
const THREEBET_CALL = "JJ-66,AQs-A9s,AJo+,KQs-KTs,QJs-QTs,JTs,T9s,98s,87s,KQo";
const FOURBET_RANGE = "KK+,AKs,AKo,A5s";
const FOURBET_CALL = "QQ-TT,AKs,AKo,AQs,A5s";
/* ── 範圍字串解析 + 補集(bunching 自動蓋牌範圍 = 該位開池範圍的補集)──────── */
/* 支援預設範圍用到的語法:XX / XX+ / XX-YY(對子)、XYs|XYo / XY?+ / XY?-XZ?(同高牌) */
function expandRangeToken(tok) {
  tok = tok.trim();
  const out = [];
  let m;
  if ((m = tok.match(/^([2-9TJQKA])\1\+$/))) {            // 77+
    for (let v = RANK_VAL[m[1]]; v <= 12; v++) { const r = "23456789TJQKA"[v]; out.push(r + r); }
  } else if ((m = tok.match(/^([2-9TJQKA])\1-([2-9TJQKA])\2$/))) { // 66-22
    const hi = RANK_VAL[m[1]], lo = RANK_VAL[m[2]];
    for (let v = lo; v <= hi; v++) { const r = "23456789TJQKA"[v]; out.push(r + r); }
  } else if ((m = tok.match(/^([2-9TJQKA])\1$/))) {        // QQ
    out.push(tok);
  } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])\+$/))) { // A9s+(kicker 升到高牌下一張)
    const hiV = RANK_VAL[m[1]];
    for (let v = RANK_VAL[m[2]]; v < hiV; v++) out.push(m[1] + "23456789TJQKA"[v] + m[3]);
  } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])-\1([2-9TJQKA])\3$/))) { // A9s-A2s
    const a = RANK_VAL[m[2]], b = RANK_VAL[m[4]];
    for (let v = Math.min(a, b); v <= Math.max(a, b); v++) out.push(m[1] + "23456789TJQKA"[v] + m[3]);
  } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])$/))) { // AKs
    out.push(tok);
  }
  return out; // 未知 token → 空(寬容)
}
function rangeLabelSet(str) {
  const set = new Set();
  str.split(",").forEach(t => expandRangeToken(t).forEach(l => set.add(l)));
  return set;
}
const ALL_LABELS = (() => {
  const out = [];
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    out.push(r === c ? RANKS[r] + RANKS[r] : (r < c ? RANKS[r] + RANKS[c] + "s" : RANKS[c] + RANKS[r] + "o"));
  }
  return [...new Set(out)];
})();
function complementRange(openStr) {
  const open = rangeLabelSet(openStr);
  return ALL_LABELS.filter(l => !open.has(l)).join(",");
}

function placeSeats(container, seats, onClick) {
  seats.forEach(s => {
    const b = el("button", "seat", s.label || s.id);
    const rad = s.ang * Math.PI / 180;
    b.style.left = (50 + 46 * Math.cos(rad)) + "%";
    b.style.top = (50 + 42 * Math.sin(rad)) + "%";
    b.dataset.seat = s.id;
    if (onClick) b.addEventListener("click", () => onClick(s.id, b));
    container.appendChild(b);
  });
}
placeSeats($("seatPicker"), SEATS6, null); // 翻後桌面:顯示翻前建構器狀態(不可點)
S.posNames = { 0:"OOP", 1:"IP" };

/* ═══════════════ 翻前行動建構器:UTG 起逐位行動(棄牌/跟注/加注…)直到剩 2 人 ═══════════════ */
/* 盲注:SB 0.5 / BB 1;開池 2.5bb(BB 對跛入加注 3bb);3-bet = OOP 4×/IP 3×;4-bet = 2.5×3bet。
   行動結束且恰 2 人 → 自動推 OOP/IP、底池/有效後手(碼深換算,1 籌碼=0.5bb)、雙方範圍、bunching 蓋牌者。 */
const PRE_ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

function newPre() {
  return {
    line: [],                                  // [{seat, act, amt}]
    invested: { UTG:0, HJ:0, CO:0, BTN:0, SB:0.5, BB:1 },
    folded: new Set(),
    level: 1, raises: 0, lastAgg: null,
    toAct: [...PRE_ORDER],
    done: false, error: null, survivors: [],
  };
}
S.pre = newPre();

function preActor() { return S.pre.done ? null : S.pre.toAct[0]; }

/* 當前行動者可用動作(含尺寸) */
function preActions() {
  const p = S.pre, s = preActor();
  if (!s) return [];
  const out = [{ act: "fold", label: "棄牌" }];
  if (p.raises === 0) {
    if (s === "BB") {
      out.push({ act: "check", label: "過牌" });
      out.push({ act: "raise", label: "加注 3bb", amt: 3 });
    } else {
      out.push({ act: "limp", label: "跛入 1bb", amt: 1 });
      out.push({ act: "raise", label: "加注 2.5bb", amt: 2.5 });
    }
  } else {
    out.push({ act: "call", label: `跟注 ${p.level}bb`, amt: p.level });
    if (p.raises === 1) {
      // 3bettor 翻後序早於開池者 = OOP → 4×;否則 3×
      const oopSide = POSTFLOP_ORDER[s] < POSTFLOP_ORDER[p.lastAgg];
      const amt = (oopSide ? 4 : 3) * p.level;
      out.push({ act: "3bet", label: `3-bet ${amt}bb`, amt });
    } else if (p.raises === 2) {
      const amt = 2.5 * p.level;
      out.push({ act: "4bet", label: `4-bet ${amt}bb`, amt });
    } // raises≥3:只剩棄牌/跟注
  }
  return out;
}

function preApply(actDef, render = true) { // render=false 供批次重放(回溯/自動棄/快速線)末尾一次渲染
  const p = S.pre, s = preActor();
  if (!s) return;
  if (actDef.act === "fold") {
    p.folded.add(s);
    p.line.push({ seat: s, act: "fold" });
    p.toAct.shift();
  } else if (actDef.act === "limp" || actDef.act === "call" || actDef.act === "check") {
    if (actDef.amt) p.invested[s] = actDef.amt;
    p.line.push({ seat: s, act: actDef.act, amt: actDef.amt });
    p.toAct.shift();
  } else { // raise / 3bet / 4bet:重開行動 → 其餘未棄牌者依序再表態
    p.level = actDef.amt;
    p.invested[s] = actDef.amt;
    p.raises = actDef.act === "raise" ? 1 : actDef.act === "3bet" ? 2 : 3;
    p.lastAgg = s;
    p.line.push({ seat: s, act: actDef.act, amt: actDef.amt });
    const idx = PRE_ORDER.indexOf(s);
    const after = [...PRE_ORDER.slice(idx + 1), ...PRE_ORDER.slice(0, idx)];
    p.toAct = after.filter(x => !p.folded.has(x));
  }
  if (!p.toAct.length) {
    p.survivors = PRE_ORDER.filter(x => !p.folded.has(x));
    p.done = true;
    if (p.survivors.length !== 2) {
      p.error = p.survivors.length < 2
        ? "全部棄牌(無翻後)— 請重新開始"
        : `需恰好 2 人進翻牌(目前 ${p.survivors.length} 人)— 本解算器為單挑`;
    }
  }
  if (render) renderPre();
}

/* 行動結束 → 推導 OOP/IP、底池/後手、範圍、bunching */
function currentOopIp() {
  const p = S.pre;
  if (!p.done || p.error) return [null, null];
  const [a, b] = p.survivors;
  return POSTFLOP_ORDER[a] < POSTFLOP_ORDER[b] ? [a, b] : [b, a];
}

function preDerive() {
  const p = S.pre;
  const [oop, ip] = currentOopIp();
  if (!oop) return;
  const depth = +$("depthBB").value || 100;
  const potBB = PRE_ORDER.reduce((t, s) => t + p.invested[s], 0); // 含蓋牌者死盲/死注
  const stackBB = Math.max(depth - p.invested[oop], 1);
  $("pot").value = Math.round(potBB * 2);   // 1 籌碼 = 0.5bb
  $("stack").value = Math.round(stackBB * 2);
  $("bbReadout").textContent = `底池 ${potBB.toFixed(1)}bb · 有效後手 ${stackBB.toFixed(1)}bb(1 籌碼 = 0.5bb)`;
  S.posNames = { 0: oop, 1: ip };
  S.seats = [oop, ip];
  $("oopRangeLabel").textContent = `OOP 範圍(${oop})`;
  $("ipRangeLabel").textContent = `IP 範圍(${ip})`;
  // 範圍預設(依最終下注層級;可手動改)
  const agg = p.lastAgg, caller = p.survivors.find(x => x !== agg);
  const set = (seat, val) => { $(seat === oop ? "oopRange" : "ipRange").value = val; };
  if (p.raises === 0) { // limped
    set(oop, BB_DEFEND); set(ip, BB_DEFEND);
  } else if (p.raises === 1) {
    set(agg, OPEN_RANGES[agg] || CALLER_GENERIC);
    set(caller, caller === "BB" ? BB_DEFEND : (caller === "SB" ? OPEN_RANGES.SB : CALLER_GENERIC));
  } else if (p.raises === 2) {
    set(agg, THREEBET_POLAR); set(caller, THREEBET_CALL);
  } else {
    set(agg, FOURBET_RANGE); set(caller, FOURBET_CALL);
  }
  if ($("bunchOn").checked) fillBunching();
  scheduleGpuEstimate(); // 翻前線改 → 範圍/底池變 → 重估(函式宣告提升,先於定義呼叫安全)
}

/* 動作標籤/色(卡片列用) */
const PRE_ACT_LABEL = e => ({
  fold: "棄牌", limp: "跛入 1bb", check: "過牌",
  call: `跟注 ${e.amt}bb`, raise: `加注 ${e.amt}bb`,
  "3bet": `3-bet ${e.amt}bb`, "4bet": `4-bet ${e.amt}bb`,
}[e.act]);
const PRE_ACT_COLOR = { fold:C.fold, limp:C.limp, check:C.check, call:C.call, raise:C.bet, "3bet":C.raise, "4bet":C.allin };

/* 以動作清單重建狀態(回溯改線用;同一狀態機重放,尺寸由 preActions 重推) */
function preReplay(entries) {
  S.pre = newPre();
  for (const e of entries) {
    const opt = preActions().find(o => o.act === e.act);
    if (!opt) break; // 理論上不發生(忠實重放)
    preApply(opt, false); // 呼叫端末尾統一渲染
  }
}

/* GTOW 卡片點擊:未行動位置 → 前面自動全棄牌直到輪到它;
   已行動位置 → 回溯到其「最後一次」動作前重選(其後動作捨棄;連點可一路往回走) */
function preCardClick(seat) {
  const p = S.pre;
  if (seat === preActor()) return; // 已輪到:選項就在卡列下方
  let last = -1;
  p.line.forEach((e, i) => { if (e.seat === seat) last = i; });
  if (last >= 0) {
    preReplay(p.line.slice(0, last));
  } else if (!p.done) {
    let guard = PRE_ORDER.length;
    while (preActor() && preActor() !== seat && guard-- > 0) preApply({ act: "fold" }, false);
  }
  renderPre();
}

function renderPre() {
  const p = S.pre;
  const actor = preActor();
  const [oop, ip] = currentOopIp();
  // 桌面座位狀態(左欄氈面,顯示用)
  document.querySelectorAll("#seatPicker .seat").forEach(e => {
    const s = e.dataset.seat;
    const ent = [...p.line].reverse().find(x => x.seat === s);
    e.classList.toggle("folded", p.folded.has(s));
    e.classList.toggle("acting", s === actor);
    e.classList.toggle("picked-oop", s === oop);
    e.classList.toggle("picked-ip", s === ip);
    e.classList.remove("picked-hero");
    e.textContent = s + (ent && ent.amt ? ` ${ent.amt}` : "");
  });
  // GTOW 卡片式動作列(中央上方):每位置一卡,列出其全部動作
  const cards = $("preCards");
  cards.innerHTML = "";
  PRE_ORDER.forEach(s => {
    const card = el("button", "pre-card");
    card.classList.toggle("folded", p.folded.has(s));
    card.classList.toggle("acting", s === actor);
    card.classList.toggle("oop", s === oop);
    card.classList.toggle("ip", s === ip);
    const ents = p.line.filter(x => x.seat === s);
    let html = `<span class="pc-seat">${s}</span>`;
    if (ents.length) {
      ents.forEach(x => { html += `<span class="pc-act" style="color:${PRE_ACT_COLOR[x.act]}">${PRE_ACT_LABEL(x)}</span>`; });
    } else if (s === actor) {
      html += `<span class="pc-act wait">行動中…</span>`;
    } else {
      html += `<span class="pc-act dim">${s === "SB" ? "盲注 0.5bb" : s === "BB" ? "盲注 1bb" : "—"}</span>`;
    }
    if (s === oop || s === ip) html += `<span class="pc-tag">${s === oop ? "OOP" : "IP"}</span>`;
    card.innerHTML = html;
    card.title = ents.length ? "點擊回溯,重選此位動作(其後動作捨棄)"
      : (s === actor ? "輪到此位 — 下方選動作" : "點擊直選此位:前面位置自動全棄牌");
    card.addEventListener("click", () => preCardClick(s));
    cards.appendChild(card);
  });
  // 卡列下方:當前行動者選項 / 錯誤 / 推導結果 + 重新開始
  const turn = $("preCardActions");
  turn.innerHTML = "";
  if (actor) {
    turn.appendChild(el("span", "pre-actor", `輪到 <b>${actor}</b>:`));
    preActions().forEach(a => {
      const b = el("button", "chip pre-act" + (a.act === "fold" ? " fold" : ""), a.label);
      b.addEventListener("click", () => preApply(a));
      turn.appendChild(b);
    });
  } else if (p.error) {
    turn.appendChild(el("span", "pre-actor", `<b style="color:var(--act-allin)">${p.error}</b>`));
  } else if (p.done) {
    turn.appendChild(el("span", "pre-actor",
      `<b style="color:var(--act-call)">${oop} = OOP</b> vs <b style="color:var(--act-bet)">${ip} = IP</b> · 點卡片可回溯改線`));
  }
  const resetB = el("button", "btn-ghost sm", "↺ 重新開始");
  resetB.style.marginLeft = "auto";
  resetB.addEventListener("click", resetPre);
  turn.appendChild(resetB);
  // 結果列(左欄)
  if (p.error) {
    $("seatDerived").innerHTML = `<b style="color:var(--act-allin)">${p.error}</b>`;
  } else if (p.done) {
    $("seatDerived").innerHTML =
      `<b class="oop">${oop} = OOP</b> vs <b class="ip">${ip} = IP</b>(翻後 ${oop} 先行動)`;
    preDerive();
  } else {
    $("seatDerived").textContent = "UTG 開始行動;或點中央位置卡片直選(前面位置自動棄牌)";
  }
}

/* 重新開始:翻前線歸零 + 清掉舊解算檢視 —— 否則中央動作列的發牌層仍顯示「舊解算」
   的公共牌,與左側公共牌選擇不同步(各說各話)。輸入(範圍/公共牌/尺寸)保留。 */
let viewGen = 0; // 檢視世代:清空檢視時遞增 → 還在跑的解算完成回呼比對後放棄自動導覽
                 //(否則:解算中重新開始 → 完成時 gotoHistory 會把剛清空的檢視灌回舊解)
function resetPre() {
  if (document.body.classList.contains("busy")) return; // 解算中不可重新開始(滑鼠已由 CSS 鎖,此處擋鍵盤觸發)
  S.pre = newPre();
  clearSolvedView();
  renderPre();
}
function clearSolvedView() {
  viewGen++;
  S.node = null; S.strategy = null; S.values = { 0:null, 1:null }; S.selLabel = null;
  S.solved = false;
  S.meta.clear(); S.treeOpen.clear();
  exitLockEdit();
  $("runoutModal").hidden = true;
  renderAll();
}

$("btnPreReset").addEventListener("click", resetPre);
$("depthBB").addEventListener("input", () => { if (S.pre.done && !S.pre.error) preDerive(); });

/* 快速線(常見 spot 一鍵) */
const QUICK_LINES = {
  btnbb: ["fold","fold","fold","raise","fold","call"],
  cobb:  ["fold","fold","raise","fold","fold","call"],
  sbbb:  ["fold","fold","fold","fold","raise","call"],
};
document.querySelectorAll(".pre-quick .chip").forEach(b => b.addEventListener("click", () => {
  S.pre = newPre();
  for (const act of QUICK_LINES[b.dataset.quick]) {
    const opts = preActions();
    const pick = opts.find(o => o.act === act) || opts.find(o => o.act === "raise") || opts[0];
    preApply(pick, false);
    if (S.pre.done) break;
  }
  renderPre();
}));

/* ═══════════════ bunching:蓋牌者(翻前建構器自動)+ 各家棄牌範圍 13×13 圖形編輯 ═══════════════ */
S.bunch = new Map();   // seat → Set(labels)
S.bunchActive = null;
$("bunchOn").addEventListener("change", () => {
  $("bunchCfg").hidden = !$("bunchOn").checked;
  if ($("bunchOn").checked) fillBunching();
});
function fillBunching() {
  const p = S.pre;
  const folded = (p.done && !p.error) ? PRE_ORDER.filter(s => p.folded.has(s)) : [];
  if (!folded.length) {
    $("bunchSeats").textContent = "先完成翻前行動(蓋牌者自動帶入)";
    S.bunch = new Map(); S.bunchActive = null;
    renderBunchEditor();
    return;
  }
  $("bunchSeats").textContent = `蓋牌:${folded.join("、")} — 點分頁切換;點格或按住拖曳塗選/擦除棄牌範圍`;
  S.bunch = new Map(folded.map(s => {
    const open = rangeLabelSet(OPEN_RANGES[s] || OPEN_RANGES.BTN);
    return [s, new Set(ALL_LABELS.filter(l => !open.has(l)))]; // 棄牌 = 開池範圍補集
  }));
  S.bunchActive = folded[0];
  renderBunchEditor();
}
function renderBunchEditor() {
  const tabs = $("bunchTabs"), grid = $("bunchGrid"), cnt = $("bunchCount");
  tabs.innerHTML = ""; grid.innerHTML = ""; cnt.textContent = "";
  if (!S.bunch.size) return;
  for (const seat of S.bunch.keys()) {
    const b = el("button", "mode-chip" + (seat === S.bunchActive ? " active" : ""), seat);
    b.addEventListener("click", () => { S.bunchActive = seat; renderBunchEditor(); });
    tabs.appendChild(b);
  }
  const set = S.bunch.get(S.bunchActive);
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const lab = labelOf(r, c);
    const cell = el("button", "mini-cell" + (set.has(lab) ? " on" : ""), lab);
    cell.dataset.lab = lab;
    grid.appendChild(cell);
  }
  // 滑動塗選:pointerdown 起塗(首格反值決定塗上/擦除),按住滑過的格套同值;單點 = 單格切換。
  // (on... 直接賦值 → 重渲染不堆疊監聽;capture 後 move 目標為 grid → elementFromPoint 找格)
  let paint = null; // null = 未在塗
  const apply = cell => {
    const lab = cell.dataset.lab;
    if (set.has(lab) === paint) return;
    if (paint) set.add(lab); else set.delete(lab);
    cell.classList.toggle("on", paint);
    cnt.textContent = `${S.bunchActive} 棄牌:${set.size}/169 labels`;
  };
  grid.onpointerdown = e => {
    const cell = e.target.closest(".mini-cell");
    if (!cell) return;
    e.preventDefault(); // 防選字/原生拖曳
    paint = !set.has(cell.dataset.lab);
    apply(cell);
    try { grid.setPointerCapture(e.pointerId); } catch {}
  };
  grid.onpointermove = e => {
    if (paint === null) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const cell = t && t.closest ? t.closest(".mini-cell") : null;
    if (cell && grid.contains(cell)) apply(cell);
  };
  grid.onpointerup = grid.onpointercancel = () => { paint = null; };
  cnt.textContent = `${S.bunchActive} 棄牌:${set.size}/169 labels`;
}

/* ═══════════════ 公共牌選擇 ═══════════════ */
function buildCardGrid(container, isOn, isDisabled, onClick) {
  container.innerHTML = "";
  SUITS.forEach(su => {
    RANKS.forEach(r => {
      const i = cardIdx(r, su.ch);
      const b = el("button", "cardbtn " + su.cls,
        `<span class="r">${r}</span><span class="s">${su.sym}</span>`);
      if (isOn(i)) b.classList.add("on");
      if (isDisabled(i)) b.disabled = true;
      b.addEventListener("click", () => onClick(i));
      container.appendChild(b);
    });
  });
}

function renderBoardPicker() {
  buildCardGrid($("boardPicker"),
    i => S.board.includes(i),
    () => false,
    i => {
      if (S.board.includes(i)) S.board = S.board.filter(x => x !== i);
      else if (S.board.length < 5) S.board.push(i);
      renderBoardPicker();
    });
  const slots = $("boardSlots");
  slots.innerHTML = "";
  for (let k = 0; k < 5; k++) {
    if (k < S.board.length) slots.appendChild(playCard(S.board[k]));
    else slots.appendChild(el("span", "playcard slot-empty", k < 3 ? "F" : (k === 3 ? "T" : "R")));
  }
}
function playCard(i, small) {
  const s = idxSuit(i);
  return el("span", `playcard ${s}${small ? " sm" : ""}`,
    `${idxRank(i)}<span class="s">${SUIT_SYM[s]}</span>`);
}
S.board = [cardIdx("T","d"), cardIdx("9","d"), cardIdx("6","h")];
renderBoardPicker();

/* 快捷 chips → 附加 token 到輸入框 */
document.querySelectorAll(".chip-row").forEach(row => {
  row.querySelectorAll(".chip").forEach(ch => ch.addEventListener("click", () => {
    const t = $(row.dataset.target);
    const tok = ch.textContent;
    const cur = t.value.split(",").map(s => s.trim()).filter(Boolean);
    if (!cur.includes(tok)) cur.push(tok);
    t.value = cur.join(",");
  }));
});

/* ═══════════════ Spot 收集 + 解算 ═══════════════ */
function collectSpot() {
  if (S.board.length < 3) throw new Error("公共牌至少 3 張(翻牌)");
  const pot = +$("pot").value, stack = +$("stack").value;
  const state = ["flop","flop","flop","flop","turn","river"][S.board.length];
  // bunching:各蓋牌家的棄牌範圍(13×13 圖形編輯;label 清單直接餵範圍解析器)
  const bunching = $("bunchOn").checked
    ? [...S.bunch.values()].filter(s => s.size > 0).map(s => [...s].join(","))
    : [];
  return {
    oop_range: $("oopRange").value.trim(),
    ip_range: $("ipRange").value.trim(),
    flop: S.board.slice(0, 3).map(cardStr).join(""),
    turn: S.board[3] !== undefined ? cardStr(S.board[3]) : null,
    river: S.board[4] !== undefined ? cardStr(S.board[4]) : null,
    pot, stack,
    bet_sizes: $("betSizes").value.trim() || "50%",
    raise_sizes: $("raiseSizes").value.trim(),
    turn_donk: $("turnDonk").value.trim() || null,
    river_donk: $("riverDonk").value.trim() || null,
    add_allin_threshold: +$("allinThr").value,
    merging_threshold: +$("mergeThr").value,
    initial_state: state,
    iterations: +$("iters").value,
    target_exploitability: pot * (+$("targetExpl").value) / 100, // % of pot → 籌碼
    bunching_fold_ranges: bunching,
  };
}

/* ── ⚡GPU VRAM 預估提示:勾選 GPU 或 spot 變更(debounce)→ estimate_gpu(建樹不解,
      slab_river_init 配置公式加總 + 裝置 free/total)→ 超過可用 VRAM 紅字警告 ── */
let estTimer = null, estGen = 0;
function scheduleGpuEstimate() {
  const box = $("gpuEst");
  if (!$("useGpu").checked) { box.hidden = true; S.gpuEst = null; return; }
  S.gpuEst = null; // spot 已變 → 舊預估作廢(防解算前 confirm 引用過期值)
  clearTimeout(estTimer);
  estTimer = setTimeout(runGpuEstimate, 700);
}
async function runGpuEstimate() {
  const box = $("gpuEst");
  let spot;
  try { spot = collectSpot(); } catch { box.hidden = true; S.gpuEst = null; return; }
  if (document.body.classList.contains("busy")) return; // 解算中後端回 409,略過本次
  const gen = ++estGen;
  box.hidden = false;
  box.classList.remove("warn");
  box.textContent = "⏳ 預估 GPU 記憶體…";
  let r;
  try { r = await api({ cmd: "estimate_gpu", spot }); }
  catch (e) {
    if (gen !== estGen) return;
    box.textContent = /進行中/.test(e.message) ? "解算中 — 完成後再預估" : "預估失敗:" + e.message;
    S.gpuEst = null;
    return;
  }
  if (gen !== estGen) return;
  S.gpuEst = r;
  const gb = b => (b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1);
  if (r.free == null) { // null = 無法查詢 VRAM / 無 CUDA 裝置(0 = 裝置存在但已滿,須續判超標)
    box.textContent = `預估 GPU 記憶體 ~${gb(r.bytes)} GB(無法查詢可用 VRAM)`;
    return;
  }
  const ok = r.bytes <= r.free * 0.9; // 留 ~10% 餘裕(context/碎片未計入預估)
  box.classList.toggle("warn", !ok);
  box.textContent = ok
    ? `✓ 預估 GPU 記憶體 ~${gb(r.bytes)} GB / 可用 ${gb(r.free)} GB${r.fp16 ? "(fp16)" : ""}`
    : `⚠ 預估 ~${gb(r.bytes)} GB > 可用 ${gb(r.free)} GB — 會 OOM:縮小範圍、減少下注尺寸、改 turn・river 起始,或改用 CPU`;
}
$("useGpu").addEventListener("change", scheduleGpuEstimate);
// 左欄任何輸入/點擊(範圍/公共牌/尺寸/碼深/bunching…)都可能改樹 → 重新預估(僅 GPU 勾選時)
$("spotRail").addEventListener("input", scheduleGpuEstimate);
$("spotRail").addEventListener("click", e => { if (e.target.closest("button")) scheduleGpuEstimate(); });

$("btnSolve").addEventListener("click", async () => {
  let spot;
  try { spot = collectSpot(); } catch (e) { alert(e.message); return; }
  const gpu = $("useGpu").checked;
  // 預估尚未就緒(剛改 spot、debounce 視窗內 S.gpuEst=null)→ 先同步補算一次,
  // 否則「超標確認」守門會被靜默跳過(改完 spot 立刻按解算就完全沒檢查)。
  if (gpu && !S.gpuEst) { clearTimeout(estTimer); await runGpuEstimate(); }
  // 預估超標 → 解算前最後確認(free 可能為 0=VRAM 滿載,須用 != null 判定而非 truthy)
  if (gpu && S.gpuEst && S.gpuEst.free != null && S.gpuEst.bytes > S.gpuEst.free * 0.9) {
    const gb = b => (b / 2 ** 30).toFixed(1);
    if (!confirm(`預估 GPU 記憶體 ~${gb(S.gpuEst.bytes)} GB 超過可用 ${gb(S.gpuEst.free)} GB,` +
                 `很可能 OOM(整機可能短暫卡頓)。仍要用 GPU 解算?`)) return;
  }
  let r;
  try { r = await apiPost("/api/solve", { spot, gpu }); }
  catch (e) { alert("連線失敗(引擎離線?):" + e.message); setEngine("err", "引擎離線"); return; }
  if (!r.ok) { alert(r.error); return; }
  $("btnSolve").disabled = true;
  await pollProgress("解算");
  $("btnSolve").disabled = false;
});

async function pollProgress(label, goRoot = true) {
  const vg = viewGen; // 期間若檢視被清空(重新開始),完成後不自動導覽
  const prog = $("progress"), fill = $("progressFill"), text = $("progressText");
  prog.hidden = false;
  setEngine("busy", label + "中…");
  // 解算中鎖住互動(動作列/樹/矩陣/spot 面板):引擎序列處理,此時 Sync 指令會被後端拒 409
  document.body.classList.add("busy");
  try {
  for (;;) {
    const st = await apiStatus();
    if (st.phase === "solving" || st.phase === "building") {
      // GPU 也有逐塊進度(分塊 launch);expl 僅 CPU 路徑期間可得
      fill.classList.remove("indeterminate");
      const pct = st.total ? (100 * st.iter / st.total) : 0;
      fill.style.width = pct.toFixed(1) + "%";
      text.textContent = (st.gpu ? "⚡ GPU " : "") + `${st.iter}/${st.total} 迭代` +
        (st.exploitability != null ? ` · expl ${st.exploitability.toFixed(3)}` : "");
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
    fill.classList.remove("indeterminate");
    if (st.phase === "done") {
      fill.style.width = "100%";
      const res = st.result || {};
      const expl = res.exploitability;
      text.textContent = `完成 · expl ${expl != null && isFinite(expl) ? expl.toFixed(4) : "—"} · OOP EV ${res.game_value_oop?.toFixed(2)}`;
      setEngine("ok", `已解 · expl ${expl != null && isFinite(expl) ? expl.toFixed(3) : "—"}`);
      if (vg !== viewGen) return false; // 解算中按了重新開始 → 檢視保持清空,不灌回舊解
      S.solved = true;
      S.meta.clear();          // 解變了 → 節點摘要快取全失效
      S.treeOpen.clear();
      if (goRoot) await gotoHistory([]);
      return true;
    }
    if (st.phase === "error") {
      text.textContent = "錯誤:" + st.error;
      setEngine("err", "解算失敗");
      return false;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  } finally {
    document.body.classList.remove("busy");
  }
}

/* ═══════════════ 節點摘要快取(line strip / tree view 共用)═══════════════ */
/* 摘要 = {node, items:[{idx,label,sub,freq,color,isCard}], actor}(決策節點含各動作聚合頻率) */
async function fetchMeta(hist) {
  const node = await api({ cmd: "navigate", history: hist });
  const m = { node, items: [], actor: null };
  if (!node.is_terminal && !node.is_chance) {
    m.actor = S.posNames[node.current_player] || (node.current_player === 0 ? "OOP" : "IP");
    let st = null;
    try { st = await api({ cmd: "strategy" }); } catch {}
    const colors = actionColors(node.available_actions);
    node.available_actions.forEach((a, ai) => {
      const meta = actionName(a);
      let freq = null;
      if (st) {
        let s = 0;
        for (let h = 0; h < st.num_hands; h++) s += st.strategy[ai * st.num_hands + h];
        freq = st.num_hands ? s / st.num_hands : 0;
      }
      m.items.push({ idx: ai, label: meta.nm, sub: a.amount ?? null, freq, color: colors[ai], isCard: false });
    });
  } else if (node.is_chance) {
    m.actor = "發牌";
  }
  S.meta.set(hkey(hist), m);
  return m;
}
async function ensureMeta(hist) {
  return S.meta.get(hkey(hist)) || await fetchMeta(hist);
}

/* ═══════════════ 導覽 ═══════════════ */
let navGen = 0; // 世代計數:快速連點時,舊的 in-flight 導覽在每個 await 後自棄
                //(否則 navigate A→B 交錯後,A 的 node 會配上 B 的 strategy)
let navTail = Promise.resolve();
// 導覽序列化:navigate / strategy / values 共用伺服端「當前節點」游標,任兩個導覽序列交錯
// 都會錯配(A 的 node 配到 B 的 strategy)。所有會移動游標的入口(gotoHistory、樹節點展開)
// 一律排隊執行,序列內各 await 照舊;navGen 讓被新導覽取代的舊序列在輪到時直接放棄。
// ⚠️ 傳入的 fn 不可再呼叫 withNav(會自我死鎖)——fetchMeta/ensureMeta 只在已序列化的入口內
// 被呼叫,故不另外包;prefix 迴圈亦不可改 Promise.all(並行 fetchMeta 會交錯游標)。
function withNav(fn) {
  const run = navTail.then(fn, fn);
  navTail = run.then(() => {}, () => {}); // tail 永不 reject
  return run;
}
function gotoHistory(hist) {
  const gen = ++navGen; // 同步戳記:連點時只有最後一個在輪到時通過 gen 檢查
  return withNav(async () => {
    if (gen !== navGen) return; // 已被更新的導覽取代 → 直接放棄(不動游標)
    // 先補齊路徑上所有前綴的摘要(line strip 需要;通常已在快取)。**須序列**:fetchMeta 走
    // navigate+strategy 共用游標,並行會錯配。
    for (let k = 0; k < hist.length; k++) {
      await ensureMeta(hist.slice(0, k));
      if (gen !== navGen) return;
    }
    const node = await api({ cmd: "navigate", history: hist });
    if (gen !== navGen) return;
    S.node = node;
    S.strategy = null; S.values = { 0:null, 1:null }; S.selLabel = null;
    exitLockEdit();
    if (!S.node.is_terminal && !S.node.is_chance) {
      try {
        const st = await api({ cmd: "strategy" });
        if (gen !== navGen) return;
        S.strategy = st;
      } catch {}
    }
    if (!S.node.is_chance) {
      for (const p of [0, 1]) {
        try {
          const v = await api({ cmd: "values", player: p });
          if (gen !== navGen) return;
          S.values[p] = v;
        } catch {}
      }
    }
    if (S.strategy) S.valPlayer = S.strategy.player;
    // 當前節點摘要(供 line strip 末層 / tree)
    await ensureMeta(hist);
    if (gen !== navGen) return;
    $("runoutModal").hidden = true; // 導覽後關閉選牌彈窗(chance 節點由 renderNodePanel 重開)
    renderAll();
  });
}

function actionName(a) {
  switch (a.kind) {
    case "fold":  return { ico:"✕", nm:"棄牌", en:"Fold", color:C.fold };
    case "check": return { ico:"✓", nm:"過牌", en:"Check", color:C.check };
    case "call":  return { ico:"◉", nm:"跟注", en:"Call", color:C.call };
    case "bet":   return { ico:"▲", nm:"下注", en:`Bet ${a.amount}`, color:null };
    case "raise": return { ico:"⇧", nm:"加注", en:`Raise ${a.amount}`, color:null };
    case "allin": return { ico:"⚡", nm:"全下", en:`All-in ${a.amount}`, color:C.allin };
    case "chance":return { ico:"❖", nm:"發牌", en:a.card || "", color:C.brass };
    default:      return { ico:"·", nm:a.kind, en:"", color:C.fold };
  }
}

/* 各動作 bar 色:bet=琥珀、raise=橙紅、allin=緋紅(style-spec §4);
   同 kind 多尺寸時依金額向下一級色插值區分 */
function actionColors(actions) {
  const ramp = { bet: [C.bet, C.raise], raise: [C.raise, C.allin] };
  const byKind = {};
  actions.forEach(a => {
    if (ramp[a.kind]) (byKind[a.kind] = byKind[a.kind] || []).push(a.amount);
  });
  return actions.map(a => {
    const base = actionName(a);
    if (base.color) return base.color;
    const amounts = byKind[a.kind];
    const lo = Math.min(...amounts), hi = Math.max(...amounts);
    const t = hi > lo ? 0.65 * (a.amount - lo) / (hi - lo) : 0;
    return lerpColor(ramp[a.kind][0], ramp[a.kind][1], t);
  });
}
function lerpColor(h1, h2, t) {
  const p = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
  const [a, b] = [p(h1), p(h2)];
  return "#" + a.map((v, i) => Math.round(v + (b[i]-v)*t).toString(16).padStart(2,"0")).join("");
}

/* ═══════════════ 渲染 ═══════════════ */
function renderAll() {
  renderBoardDisplay();
  renderLineStrip();
  renderTree();
  renderNodePanel();
  renderLockSection();
  renderMatrix();
}

function renderBoardDisplay() {
  const bd = $("boardDisplay");
  bd.innerHTML = "";
  if (!S.node) { bd.innerHTML = '<span class="hint">—</span>'; return; }
  S.node.board_idx.forEach((i, k) => {
    bd.appendChild(playCard(i));
    if (k === 2 || k === 3) bd.appendChild(el("span", "hint", "·"));
  });
}

/* ── GTOW 逐層動作列:發牌(翻牌)→ 翻後各層(位置 + 全部動作頻率);
      翻前段由上方卡片列(#preCards)呈現。點同層其他動作 = 改線 ── */
function renderLineStrip() {
  const strip = $("lineStrip");
  if (!S.node) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = "";
  const hist = S.node.history;

  // 發牌・翻牌層:起始公共牌(翻牌 3 張;turn/river 起始 spot 含其起始牌)。點擊 = 回翻後起點。
  const rootMeta = S.meta.get(hkey([]));
  const initBoard = rootMeta ? rootMeta.node.board_idx : S.node.board_idx.slice(0, 3);
  const lvF = el("div", "line-level");
  const dealName = initBoard.length === 3 ? "翻牌" : "起始牌"; // turn/river 起始 spot 含其起始牌
  lvF.appendChild(el("div", "line-actor", `<span class="pos">發牌</span> ${dealName}`));
  const itemsF = el("div", "line-items");
  const bF = el("button", "line-item" + (hist.length === 0 ? " chosen" : ""));
  initBoard.forEach(i => bF.appendChild(playCard(i, true)));
  bF.title = "回到翻後起點";
  bF.addEventListener("click", () => gotoHistory([]));
  itemsF.appendChild(bF);
  lvF.appendChild(itemsF);
  strip.appendChild(lvF);

  for (let k = 0; k <= hist.length; k++) {
    const prefix = hist.slice(0, k);
    const m = S.meta.get(hkey(prefix));
    if (!m) continue;
    if (m.node.is_terminal) {
      const lv = el("div", "line-level");
      lv.appendChild(el("div", "line-actor", "終端"));
      lv.appendChild(el("div", "line-items", '<span class="line-item chosen">■ 結束</span>'));
      strip.appendChild(lv);
      continue;
    }
    const lv = el("div", "line-level");
    const chosen = k < hist.length ? hist[k] : null;
    if (m.node.is_chance) {
      lv.appendChild(el("div", "line-actor", `<span class="pos">發牌</span>`));
      const items = el("div", "line-items");
      if (chosen != null) {
        // 已發的牌:點擊回到該 chance 節點重選
        const b = el("button", "line-item chosen");
        b.appendChild(playCard(chosen, true));
        b.title = "點擊重選 runout";
        b.addEventListener("click", () => gotoHistory(prefix));
        items.appendChild(b);
      } else {
        const b = el("button", "line-item chosen", "❖ 選牌…");
        b.addEventListener("click", () => openRunoutModal(S.node)); // 中央彈窗
        items.appendChild(b);
      }
      lv.appendChild(items);
    } else {
      lv.appendChild(el("div", "line-actor", `<span class="pos">${m.actor}</span> 行動`));
      const items = el("div", "line-items");
      m.items.forEach(it => {
        const b = el("button", "line-item" + (chosen === it.idx ? " chosen" : ""));
        b.innerHTML = `${it.label}${it.sub != null ? " " + it.sub : ""}` +
          (it.freq != null ? `<span class="lfreq">${fmtPct(it.freq)}</span>` : "");
        const bar = el("div", "lbar");
        bar.style.width = ((it.freq ?? 0) * 100) + "%";
        bar.style.background = it.color;
        b.appendChild(bar);
        b.addEventListener("click", () => gotoHistory([...prefix, it.idx])); // 同層改線(其後重置)
        items.appendChild(b);
      });
      lv.appendChild(items);
    }
    strip.appendChild(lv);
  }
}

/* ── Pio 式可展開賽局樹側欄(惰性載入;與 line strip 共用 meta 快取)── */
function renderTree() {
  const tv = $("treeView");
  if (!S.node) { tv.innerHTML = '<span class="hint">解算後可展開瀏覽</span>'; return; }
  tv.innerHTML = "";
  const rootRow = el("div", "tree-row" + (S.node.history.length === 0 ? " cur" : ""));
  rootRow.innerHTML = `<span class="tw"></span><span class="tname">ROOT</span>`;
  rootRow.addEventListener("click", () => gotoHistory([]));
  tv.appendChild(rootRow);
  addTreeChildren(tv, [], 1);
}

function addTreeChildren(container, hist, depth) {
  const m = S.meta.get(hkey(hist));
  if (!m || m.node.is_terminal) return;
  const curKey = hkey(S.node.history);
  if (m.node.is_chance) {
    // chance:不展開 49 張;當前線上已發的牌顯示為一列
    const onPath = S.node.history.length > hist.length &&
      hkey(S.node.history.slice(0, hist.length)) === hkey(hist);
    const card = onPath ? S.node.history[hist.length] : null;
    const row = el("div", "tree-row");
    row.style.paddingLeft = (depth * 14) + "px";
    row.innerHTML = `<span class="tw">❖</span><span class="tactor">發牌</span><span class="tname">${
      card != null ? idxRank(card) + SUIT_SYM[idxSuit(card)] : "(點選 runout)"}</span>`;
    row.addEventListener("click", () => gotoHistory(hist)); // 回 chance 節點選牌
    container.appendChild(row);
    if (card != null) {
      const childHist = [...hist, card];
      if (hkey(childHist) === curKey || S.treeOpen.has(hkey(childHist))) {
        addTreeChildren(container, childHist, depth + 1);
      }
    }
    return;
  }
  m.items.forEach(it => {
    const childHist = [...hist, it.idx];
    const ck = hkey(childHist);
    const row = el("div", "tree-row" + (ck === curKey ? " cur" : ""));
    row.style.paddingLeft = (depth * 14) + "px";
    const open = S.treeOpen.has(ck);
    row.innerHTML =
      `<span class="tw">${open ? "▾" : "▸"}</span>` +
      `<span class="tactor">${m.actor}</span>` +
      `<span class="tname" style="color:${it.color}">${it.label}${it.sub != null ? " " + it.sub : ""}</span>` +
      `<span class="tfreq">${it.freq != null ? fmtPct(it.freq) : ""}</span>`;
    row.querySelector(".tw").addEventListener("click", async ev => {
      ev.stopPropagation();
      if (S.treeOpen.has(ck)) S.treeOpen.delete(ck);
      else {
        S.treeOpen.add(ck);
        if (!S.meta.has(ck)) {
          // 經 withNav 序列化:此處 navigate(子)→ strategy → navigate(回當前)會移動共用游標,
          // 若與 gotoHistory 交錯會錯配策略。排隊執行即可保證原子性。
          await withNav(async () => {
            await ensureMeta(childHist);                       // 惰性抓子節點摘要
            await api({ cmd: "navigate", history: S.node.history }); // 引擎導回當前
          });
        }
      }
      renderTree();
    });
    row.addEventListener("click", () => gotoHistory(childHist));
    container.appendChild(row);
    if (open) addTreeChildren(container, childHist, depth + 1);
  });
}

function renderNodePanel() {
  const n = S.node;
  const who = $("nodeWho"), list = $("actionList"), runout = $("runoutPicker");
  const badge = $("lockBadge");
  badge.hidden = !(n && n.locked);
  if (n && n.locked) badge.textContent = `🔒 已鎖定 ${n.locked_hands} 手`;
  runout.hidden = true;
  if (!n) { who.textContent = "當前節點"; list.innerHTML = '<span class="hint">—</span>'; return; }

  if (n.is_terminal) {
    who.textContent = "終端節點";
    list.innerHTML = "";
    list.appendChild(el("div", "terminal-note", "■ 攤牌 / 棄牌終端 — 切 EV/EQ 檢視結果"));
    return;
  }
  if (n.is_chance) {
    who.textContent = "機會節點(發牌)";
    list.innerHTML = "";
    runout.hidden = false;
    $("runoutTitle").textContent = n.board_idx.length === 3 ? "選擇轉牌 TURN" : "選擇河牌 RIVER";
    openRunoutModal(n); // 中央彈窗選牌(右欄按鈕可重開)
    return;
  }

  const pos = S.posNames[n.current_player] || (n.current_player === 0 ? "OOP" : "IP");
  who.innerHTML = `行動方:<span style="color:var(--brass-bright)">${pos}</span>(${n.current_player === 0 ? "OOP" : "IP"})`;

  const colors = actionColors(n.available_actions);
  const aggs = aggregateFreqs();
  list.innerHTML = "";
  n.available_actions.forEach((a, ai) => {
    const m = actionName(a);
    const freq = aggs ? aggs[ai] : null;
    const b = el("button", "actbtn",
      `<span class="ico" style="color:${colors[ai]}">${m.ico}</span>
       <span class="name">${m.nm}<small>${m.en}</small></span>
       <span class="freq">${freq != null ? fmtPct(freq) : ""}</span>`);
    if (freq != null) {
      const fb = el("div", "freqbar");
      fb.style.width = (freq * 100) + "%";
      fb.style.background = colors[ai];
      b.appendChild(fb);
    }
    b.addEventListener("click", async () => gotoHistory([...n.history, ai]));
    list.appendChild(b);
  });
}

/* 全節點各動作未加權平均頻率 */
function aggregateFreqs() {
  const st = S.strategy;
  if (!st) return null;
  const { num_actions: na, num_hands: nh, strategy } = st;
  const out = [];
  for (let a = 0; a < na; a++) {
    let s = 0;
    for (let h = 0; h < nh; h++) s += strategy[a * nh + h];
    out.push(nh ? s / nh : 0);
  }
  return out;
}

/* ═══════════════ 13×13 矩陣 ═══════════════ */
document.querySelectorAll("#viewToggle .vt").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#viewToggle .vt").forEach(x => x.classList.toggle("active", x === b));
  S.view = b.dataset.view;
  renderMatrix();
}));

function labelOf(r, c) {
  if (r === c) return RANKS[r] + RANKS[r];
  if (r < c) return RANKS[r] + RANKS[c] + "s";
  return RANKS[c] + RANKS[r] + "o";
}

function cellData() {
  const map = new Map();
  const src = S.view === "strategy" ? S.strategy : S.values[S.valPlayer];
  if (!src) return null;
  src.hands.forEach((h, hi) => {
    if (!map.has(h.label)) map.set(h.label, []);
    map.get(h.label).push(hi);
  });
  return { src, map };
}

function renderMatrix() {
  const mx = $("matrix"), empty = $("matrixEmpty");
  const banner = $("actorBanner");
  const data = cellData();
  mx.innerHTML = "";
  if (!S.node || !data) {
    mx.hidden = true; empty.hidden = false;
    $("legend").innerHTML = "";
    $("comboStrip").hidden = true;
    banner.textContent = !S.solved ? "尚未解算 — 左側設定 spot 後按「解算」" :
      (S.node && S.node.is_chance ? "機會節點 — 右側選 runout" : "此節點無資料");
    return;
  }
  mx.hidden = false; empty.hidden = true;

  const { src, map } = data;
  const isStrat = S.view === "strategy";
  const actor = isStrat ? src.player : S.valPlayer;
  const posName = S.posNames[actor] || (actor === 0 ? "OOP" : "IP");
  banner.innerHTML = `<span class="pos">${posName}</span> 的 ${isStrat ? "策略" : (S.view === "ev" ? "期望值 EV" : "底池權益 EQ")}`;

  let colors = null, evRange = null;
  if (isStrat) {
    colors = actionColors(src.actions);
    renderLegend(src.actions, colors);
  } else {
    renderValueControls();
    if (S.view === "ev") {
      let lo = Infinity, hi = -Infinity;
      src.ev.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
      evRange = { lo, hi };
    }
  }

  const nh = src.num_hands ?? src.hands.length;
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const lab = labelOf(r, c);
    const combos = map.get(lab);
    const cell = el("button", "mcell");
    cell.dataset.lab = lab; // 供 cellClick 鎖定選格時定點 toggle(免整盤重繪)
    cell.style.animationDelay = ((r + c) * 9) + "ms";
    cell.appendChild(el("span", "lab", lab));
    if (!combos) {
      cell.classList.add("absent");
    } else if (isStrat) {
      const na = src.num_actions;
      const bars = el("div", "bars");
      for (let a = 0; a < na; a++) {
        let s = 0;
        combos.forEach(hi => s += src.strategy[a * nh + hi]);
        const w = s / combos.length;
        if (w > 0.001) {
          const seg = el("div", "seg");
          seg.style.width = (w * 100) + "%";
          seg.style.background = colors[a];
          bars.appendChild(seg);
        }
      }
      cell.appendChild(bars);
      cell.classList.add("darklab");
      cell.addEventListener("click", () => cellClick(lab));
    } else {
      let v = 0;
      combos.forEach(hi => v += (S.view === "ev" ? src.ev[hi] : src.equity[hi]));
      v /= combos.length;
      let t, txt;
      if (S.view === "ev") {
        t = evRange.hi > evRange.lo ? (v - evRange.lo) / (evRange.hi - evRange.lo) : 0.5;
        txt = v.toFixed(Math.abs(v) >= 100 ? 0 : 1);
      } else { t = v; txt = (v * 100).toFixed(0); }
      cell.style.background = heatColor(t);
      cell.classList.toggle("darklab", t < 0.45 || t > 0.8);
      cell.appendChild(el("span", "val", txt));
      cell.addEventListener("click", () => cellClick(lab));
    }
    // 鎖定選格模式:選中亮框、未選壓暗
    if (S.lockEditMode && combos) {
      cell.classList.toggle("locksel", S.lockSel.has(lab));
      cell.classList.toggle("lockdim", !S.lockSel.has(lab));
    }
    if (!S.lockEditMode && S.selLabel === lab) cell.classList.add("sel");
    mx.appendChild(cell);
  }
  renderComboStrip();
}

function cellClick(lab) {
  if (S.lockEditMode) {
    const sel = !S.lockSel.has(lab);
    if (sel) S.lockSel.add(lab); else S.lockSel.delete(lab);
    $("lockPickCount").textContent = `已選 ${S.lockSel.size} 個 label`;
    // 只更新被點的格(免重建全部 169 個 mcell → 避免連點時整盤閃爍/卡頓)
    const cell = $("matrix").querySelector(`.mcell[data-lab="${lab}"]`);
    if (cell) { cell.classList.toggle("locksel", sel); cell.classList.toggle("lockdim", !sel); }
    return;
  }
  S.selLabel = S.selLabel === lab ? null : lab;
  renderMatrix();
}

function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? lerpColor("#2c4875", "#343b33", t * 2) : lerpColor("#343b33", "#b03a2e", (t - 0.5) * 2);
}

function renderLegend(actions, colors) {
  const lg = $("legend");
  lg.innerHTML = "";
  actions.forEach((a, i) => {
    const m = actionName(a);
    lg.appendChild(el("span", "legend-item",
      `<span class="legend-swatch" style="background:${colors[i]}"></span>${m.nm}${a.amount ? " " + a.amount : ""}`));
  });
}

function renderValueControls() {
  const lg = $("legend");
  lg.innerHTML = "";
  [0, 1].forEach(p => {
    const b = el("button", "chip", (S.posNames[p] || (p ? "IP" : "OOP")));
    if (p === S.valPlayer) b.style.color = "var(--brass-bright)";
    b.addEventListener("click", () => { S.valPlayer = p; renderMatrix(); });
    lg.appendChild(b);
  });
}

function renderComboStrip() {
  const strip = $("comboStrip"), rows = $("comboRows");
  if (!S.selLabel || S.lockEditMode) { strip.hidden = true; return; }
  const stData = S.strategy, valData = S.values[stData ? stData.player : S.valPlayer];
  const src = stData || valData;
  if (!src) { strip.hidden = true; return; }
  strip.hidden = false;
  $("comboTitle").textContent = `${S.selLabel} — 逐 COMBO`;
  rows.innerHTML = "";
  const nh = src.num_hands ?? src.hands.length;
  const colors = stData ? actionColors(stData.actions) : null;
  src.hands.forEach((h, hi) => {
    if (h.label !== S.selLabel) return;
    const row = el("div", "combo-row");
    const cards = el("span", "combo-cards");
    cards.appendChild(playCard(cardIdx(h.c1[0], h.c1[1]), true));
    cards.appendChild(playCard(cardIdx(h.c2[0], h.c2[1]), true));
    row.appendChild(cards);
    if (stData) {
      const bar = el("div", "combo-bar");
      for (let a = 0; a < stData.num_actions; a++) {
        const w = stData.strategy[a * nh + hi];
        if (w > 0.001) {
          const seg = el("div", "seg");
          seg.style.width = (w * 100) + "%";
          seg.style.background = colors[a];
          bar.appendChild(seg);
        }
      }
      row.appendChild(bar);
    }
    if (valData) {
      const vhi = valData.hands.findIndex(x => x.c1 === h.c1 && x.c2 === h.c2);
      if (vhi >= 0) {
        row.appendChild(el("span", "combo-nums",
          `EV ${valData.ev[vhi].toFixed(1)} · EQ ${(valData.equity[vhi]*100).toFixed(0)}%`));
      }
    }
    rows.appendChild(row);
  });
}

/* ═══════════════ 節點鎖定(per-hand 部分鎖定:選格 + 滑桿)═══════════════ */
function renderLockSection() {
  const sec = $("lockSection");
  const n = S.node;
  const editable = n && !n.is_terminal && !n.is_chance && S.strategy;
  sec.hidden = !n;
  if (!n) return;
  $("btnLockEdit").hidden = !editable || n.locked;
  $("btnUnlock").hidden = !n.locked;
  $("lockEditor").hidden = !S.lockEditMode;
  $("lockpickBar").hidden = !S.lockEditMode;
  const anyLock = n.locked_count > 0;
  $("resolveRow").hidden = !anyLock;
  $("lockCount").textContent = anyLock ? `已鎖定 ${n.locked_count} 個節點` : "";
}

function exitLockEdit() {
  S.lockEditMode = false;
  S.lockSel.clear();
}

$("btnLockEdit").addEventListener("click", () => {
  const st = S.strategy;
  if (!st) return;
  S.lockEditMode = true;
  S.lockSel = new Set(st.hands.map(h => h.label)); // 預設全選(= 全節點鎖定;點格排除 = 部分鎖定)
  $("lockPickCount").textContent = `已選 ${S.lockSel.size} 個 label`;
  const aggs = aggregateFreqs();
  const colors = actionColors(st.actions);
  const box = $("lockSliders");
  box.innerHTML = "";
  st.actions.forEach((a, i) => {
    const m = actionName(a);
    const row = el("div", "lock-slider-row");
    row.innerHTML =
      `<span class="nm" style="color:${colors[i]}">${m.nm}${a.amount ? " " + a.amount : ""}</span>
       <input type="range" min="0" max="100" step="1" value="${Math.round(aggs[i]*100)}" data-ai="${i}">
       <span class="pv">${Math.round(aggs[i]*100)}%</span>`;
    row.querySelector("input").addEventListener("input", e => {
      row.querySelector(".pv").textContent = e.target.value + "%";
    });
    box.appendChild(row);
  });
  renderLockSection();
  renderMatrix();
});

$("btnLockAll").addEventListener("click", () => {
  if (!S.strategy) return;
  S.lockSel = new Set(S.strategy.hands.map(h => h.label));
  $("lockPickCount").textContent = `已選 ${S.lockSel.size} 個 label`;
  renderMatrix();
});
$("btnLockNone").addEventListener("click", () => {
  S.lockSel.clear();
  $("lockPickCount").textContent = "已選 0 個 label";
  renderMatrix();
});

$("btnLockCancel").addEventListener("click", () => { exitLockEdit(); renderLockSection(); renderMatrix(); });

$("btnLockApply").addEventListener("click", async () => {
  const st = S.strategy, n = S.node;
  if (!st || !n) return;
  if (!S.lockSel.size) { alert("請至少選一個 label(未選 = 不鎖)"); return; }
  const na = st.num_actions, nh = st.num_hands;
  const sliders = [...$("lockSliders").querySelectorAll("input")].map(i => +i.value / 100);
  const sliderSum = sliders.reduce((x, y) => x + y, 0);
  // 所有動作皆 0% → 沒有可鎖定的分佈。直接拒絕,而非靜默寫成 1/na 均勻鎖
  //(零欄 = 不鎖的後端語義:寫均勻反而把這些手鎖成均勻策略)。
  if (sliderSum <= 1e-9) { alert("所有動作頻率皆為 0% — 沒有可鎖定的分佈(要解除鎖定請用解鎖)"); return; }
  // 滑桿縮放基準 = 選中手的聚合頻率
  const aggSel = new Array(na).fill(0);
  let nSel = 0;
  st.hands.forEach((h, hi) => {
    if (!S.lockSel.has(h.label)) return;
    nSel++;
    for (let a = 0; a < na; a++) aggSel[a] += st.strategy[a * nh + hi];
  });
  for (let a = 0; a < na; a++) aggSel[a] = nSel ? aggSel[a] / nSel : 0;
  // 逐手構造:選中 → 縮放(結構保留);未選 → 全 0 欄 = 不鎖(後端 per-hand 部分鎖定)
  const flat = new Array(na * nh).fill(0);
  st.hands.forEach((h, hi) => {
    if (!S.lockSel.has(h.label)) return;
    let sum = 0;
    for (let a = 0; a < na; a++) {
      const old = st.strategy[a * nh + hi];
      const w = aggSel[a] > 1e-6 ? old * (sliders[a] / aggSel[a]) : sliders[a];
      flat[a * nh + hi] = w;
      sum += w;
    }
    if (sum <= 1e-12) {
      // 縮放後此手全 0(策略不落在滑桿偏好的動作上)→ 退用滑桿分佈本身(sliderSum>0 已保證)
      for (let a = 0; a < na; a++) flat[a * nh + hi] = sliders[a] / sliderSum;
    }
  });
  try {
    S.node = await api({ cmd: "lock", history: n.history, strategy: flat });
    S.strategy = await api({ cmd: "strategy" });
    S.meta.delete(hkey(n.history)); await ensureMeta(n.history); // 摘要含頻率 → 更新
    exitLockEdit();
    renderAll();
  } catch (e) { alert("鎖定失敗:" + e.message); }
});

/* ── 發牌中央彈窗(chance 節點)── */
function openRunoutModal(n) {
  if (!n || !n.is_chance) return;
  $("runoutModalTitle").textContent =
    (n.board_idx.length === 3 ? "選擇轉牌 TURN" : "選擇河牌 RIVER") + " — 點選一張牌";
  const used = new Set(n.board_idx);
  buildCardGrid($("runoutModalGrid"), () => false, i => used.has(i), async i => {
    $("runoutModal").hidden = true;
    await gotoHistory([...n.history, i]);
  });
  $("runoutModal").hidden = false;
}
$("btnRunoutClose").addEventListener("click", () => { $("runoutModal").hidden = true; });
$("btnRunoutOpen").addEventListener("click", () => openRunoutModal(S.node));
$("runoutModal").addEventListener("click", e => {
  if (e.target === $("runoutModal")) $("runoutModal").hidden = true; // 點背景關閉
});

$("btnUnlock").addEventListener("click", async () => {
  try {
    S.node = await api({ cmd: "unlock", history: S.node.history });
    renderAll();
  } catch (e) { alert("解鎖失敗:" + e.message); }
});

$("btnResolve").addEventListener("click", async () => {
  const hist = S.node ? [...S.node.history] : [];
  const pot = +$("pot").value;
  let r;
  try {
    r = await apiPost("/api/resolve", {
      iterations: +$("iters").value,
      target_exploitability: pot * (+$("targetExpl").value) / 100,
      gpu: $("useGpu").checked, // GPU 鎖定重解(kernel 內鎖定手凍結)
    });
  } catch (e) { alert("連線失敗(引擎離線?):" + e.message); setEngine("err", "引擎離線"); return; }
  if (!r.ok) { alert(r.error); return; }
  $("btnResolve").disabled = true;
  const ok = await pollProgress("鎖定重解", false);
  $("btnResolve").disabled = false;
  if (ok) {
    S.meta.clear();
    S.treeOpen.clear();
    await gotoHistory(hist); // 重解後回原節點
  }
});

/* ═══════════════ Preflop 分頁 ═══════════════ */
const PF_SEATS = [
  { id:"UTG",        short:"UTG",   label:"UTG",  ang:270 },
  { id:"UTG_1",      short:"UTG_1", label:"UTG+1",ang:310 },
  { id:"UTG_2",      short:"UTG_2", label:"UTG+2",ang:350 },
  { id:"Lojack",     short:"LJ",    label:"LJ",   ang:30 },
  { id:"Hijack",     short:"HJ",    label:"HJ",   ang:70 },
  { id:"Cutoff",     short:"CO",    label:"CO",   ang:110 },
  { id:"Button",     short:"BTN",   label:"BTN",  ang:150 },
  { id:"Small_Blind",short:"SB",    label:"SB",   ang:190 },
  { id:"BB",         short:"BB",    label:"BB",   ang:230 },
];
const PF_MODES = [
  { id:"RFI", label:"首入 RFI" },
  { id:"vs",  label:"面對加注" },
  { id:"3bet",label:"面對 3-bet" },
];
const PF_ACT = {
  fold:        { color:"#343b33", label:"棄牌",      dark:true },
  limp:        { color:C.limp,   label:"跛入 Limp" },
  call:        { color:C.call,   label:"跟注 Call" },
  raise:       { color:C.raise,  label:"加注 Raise" },
  raise_bluff: { color:C.bluff,  label:"加注(bluff)" },
  "3bet_value":{ color:C.raise,  label:"3-bet 價值" },
  "3bet_bluff":{ color:C.bluff,  label:"3-bet 詐唬" },
  "4bet_value":{ color:C.allin,  label:"4-bet 價值" },
  "4bet_bluff":{ color:C.bluff,  label:"4-bet 詐唬" },
};

async function loadPreflop() {
  try {
    const r = await fetch("/api/preflop");
    S.pf.charts = await r.json();
  } catch (e) {
    $("pfTitle").textContent = "讀取 charts.json 失敗:" + e.message;
    return;
  }
  placeSeats($("pfSeats"), PF_SEATS, id => {
    S.pf.seat = id;
    document.querySelectorAll("#pfSeats .seat").forEach(e =>
      e.classList.toggle("picked-hero", e.dataset.seat === id));
    renderPfNodes();
  });
  const modes = $("pfModes");
  PF_MODES.forEach(m => {
    const b = el("button", "mode-chip" + (m.id === S.pf.mode ? " active" : ""), m.label);
    b.dataset.mode = m.id;
    b.addEventListener("click", () => {
      S.pf.mode = m.id;
      document.querySelectorAll("#pfModes .mode-chip").forEach(x =>
        x.classList.toggle("active", x.dataset.mode === m.id));
      renderPfNodes();
    });
    modes.appendChild(b);
  });
  const meta = S.pf.charts.meta || {};
  $("pfMeta").innerHTML =
    `來源:${meta.source || "?"}<br>桌型:${meta.table || "?"} · ${meta.stack || ""}<br>` +
    `尺寸:${meta.sizes || ""}<br>${meta.note || ""}`;
  $("pfQuery").addEventListener("input", renderPfAnswer);
}

function pfNodesFor(seatId, mode) {
  const seat = PF_SEATS.find(s => s.id === seatId);
  if (!seat || !S.pf.charts) return [];
  const keys = Object.keys(S.pf.charts.nodes);
  return keys.filter(k => {
    if (mode === "RFI") return k === seat.id + "_RFI";
    if (!k.includes("_vs_")) return false;
    const hero = k.split("_vs_")[0];
    const mine = hero === seat.short || hero === seat.id ||
      hero === seat.short + "_RFI" || hero === seat.short + "_Limp";
    if (!mine) return false;
    const is3b = /3bet/i.test(k);
    return mode === "3bet" ? is3b : !is3b;
  });
}

function renderPfNodes() {
  const box = $("pfNodes");
  box.innerHTML = "";
  if (!S.pf.seat) { $("pfSeatHint").textContent = "點選你的位置"; return; }
  $("pfSeatHint").textContent = "位置:" + (PF_SEATS.find(s => s.id === S.pf.seat)?.label || S.pf.seat);
  const keys = pfNodesFor(S.pf.seat, S.pf.mode);
  if (!keys.length) {
    box.innerHTML = '<span class="hint">此位置無對應圖表(例:BB 無 RFI)</span>';
    S.pf.node = null; renderPfMatrix(); return;
  }
  if (!keys.includes(S.pf.node)) S.pf.node = keys[0];
  keys.forEach(k => {
    const n = S.pf.charts.nodes[k];
    const b = el("button", "node-chip" + (k === S.pf.node ? " active" : ""), n.title || k);
    b.addEventListener("click", () => {
      S.pf.node = k;
      box.querySelectorAll(".node-chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      renderPfMatrix();
    });
    box.appendChild(b);
  });
  renderPfMatrix();
}

function renderPfMatrix() {
  const mx = $("pfMatrix"), empty = $("pfEmpty");
  mx.innerHTML = "";
  const key = S.pf.node;
  if (!key || !S.pf.charts.nodes[key]) {
    mx.hidden = true; empty.hidden = false;
    $("pfTitle").textContent = "選位置 → 選情境";
    $("pfLegend").innerHTML = "";
    return;
  }
  mx.hidden = false; empty.hidden = true;
  const node = S.pf.charts.nodes[key];
  $("pfTitle").innerHTML = `<span class="pos">${node.title || key}</span>`;
  const used = new Set();
  const q = normalizeHand($("pfQuery").value);
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const lab = labelOf(r, c);
    const act = node.actions[lab] || "fold";
    used.add(act);
    const meta = PF_ACT[act] || PF_ACT.fold;
    const cell = el("div", "mcell" + (meta.dark ? " darklab" : ""));
    cell.style.background = meta.color;
    if (act === "fold") cell.style.opacity = ".45";
    cell.appendChild(el("span", "lab", lab));
    if (q === lab) cell.classList.add("hl");
    mx.appendChild(cell);
  }
  const lg = $("pfLegend");
  lg.innerHTML = "";
  [...used].sort().forEach(a => {
    const m = PF_ACT[a] || PF_ACT.fold;
    lg.appendChild(el("span", "legend-item",
      `<span class="legend-swatch" style="background:${m.color}"></span>${m.label}`));
  });
  renderPfAnswer();
}

function normalizeHand(s) {
  s = (s || "").trim().toUpperCase().replace(/10/g, "T");
  if (s.length < 2) return null;
  const r1 = s[0], r2 = s[1];
  if (!(r1 in RANK_VAL) || !(r2 in RANK_VAL)) return null;
  const [hi, lo] = RANK_VAL[r1] >= RANK_VAL[r2] ? [r1, r2] : [r2, r1];
  if (hi === lo) return hi + lo;
  const suf = s[2] === "S" ? "s" : s[2] === "O" ? "o" : null;
  if (!suf) return null;
  return hi + lo + suf;
}

function renderPfAnswer() {
  const box = $("pfAnswer");
  const lab = normalizeHand($("pfQuery").value);
  const key = S.pf.node;
  if (!lab || !key) { box.innerHTML = ""; renderPfHl(lab); return; }
  const act = S.pf.charts.nodes[key].actions[lab] || "fold";
  const m = PF_ACT[act] || PF_ACT.fold;
  box.innerHTML = `${lab} →<span class="act-tag" style="background:${m.color}">${m.label}</span>`;
  renderPfHl(lab);
}
function renderPfHl(lab) {
  const cells = $("pfMatrix").children;
  let k = 0;
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++, k++) {
    if (cells[k]) cells[k].classList.toggle("hl", labelOf(r, c) === lab);
  }
}

/* ═══════════════ 啟動 ═══════════════ */
renderPre();
(async () => {
  try {
    const pong = await api({ cmd: "ping" });
    if (pong === "pong") setEngine("idle", "引擎待命");
  } catch {
    setEngine("err", "引擎離線");
    $("btnSolve").disabled = true;
    $("btnResolve").disabled = true;
  }
})();
