/* ═══════════════════════════════════════════════════════════════════════════
   wasm-shim.js — 瀏覽器版 HTTP bridge(對應 serve.rs 的 HTTP 層)
   於 app.js 之前載入:攔截 fetch("/api…") → Web Worker(slab-worker.js);app.js 不需修改。
     POST /api           → worker api(解算中回 409,同 serve)
     POST /api/solve     → fire-and-forget,進度寫入本地 status
     POST /api/resolve   → 同上
     GET  /api/status    → 本地 status(不經 worker,解算中亦可輪詢)
     GET  /api/preflop   → 404(網頁版未附翻前圖表)
   另:隱藏 GPU / 翻前分頁、flop 解算前確認、頂部說明列。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
(() => {
  const worker = new Worker("slab-worker.js");
  const pending = new Map();   // id → resolve(api 回覆 / job begin)
  let nextId = 1;

  // 同 serve.rs Progress:{phase, iter, total, exploitability, gpu, result|error}
  const status = { phase: "idle", iter: 0, total: 0, exploitability: null, gpu: false };
  const busy = () => status.phase === "building" || status.phase === "solving";

  worker.onmessage = ({ data: m }) => {
    const j = JSON.parse(m.json);
    if (m.type === "api") {
      pending.get(m.id)?.(j); pending.delete(m.id);
    } else if (m.type === "begin") {
      if (j.ok) { status.phase = "solving"; Object.assign(status, j.result); }
      else { status.phase = "error"; status.error = j.error; }
    } else if (m.type === "progress") {
      Object.assign(status, j);
    } else if (m.type === "done") {
      if (j.ok) {
        status.phase = "done"; status.result = j.result; status.iter = status.total;
      } else { status.phase = "error"; status.error = j.error; }
    }
  };

  const respond = (obj, code = 200) =>
    new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });

  function apiCall(body) {
    return new Promise(res => {
      const id = nextId++;
      pending.set(id, res);
      worker.postMessage({ id, type: "api", body });
    });
  }

  function startJob(type, body, total) {
    if (busy()) return respond({ ok: false, error: "解算進行中(等 status=done/error 後再送)" }, 409);
    Object.assign(status, { phase: "building", iter: 0, total, exploitability: null, gpu: false });
    delete status.result; delete status.error;
    worker.postMessage({ id: nextId++, type, body });
    return respond({ ok: true, started: true });
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const path = new URL(url, location.href).pathname;
    const method = (init.method || "GET").toUpperCase();
    if (path !== "/api" && !path.startsWith("/api/")) return origFetch(input, init);

    if (path === "/api/status") return respond({ ...status });
    if (path === "/api/preflop") return respond({ ok: false, error: "網頁版未附翻前圖表" }, 404);
    if (method !== "POST") return respond({ ok: false, error: "method not allowed" }, 405);

    const body = init.body || "";
    if (path === "/api/solve") {
      const req = JSON.parse(body);
      if (req.spot?.initial_state === "flop" && !confirm(
        "瀏覽器版解「翻牌(3 張公共牌)」可能要好幾分鐘、吃掉 1GB 以上記憶體,寬範圍甚至會跑不動。\n" +
        "建議點 4~5 張公共牌解轉牌 / 河牌,或縮小範圍、減少下注尺寸。\n\n仍要繼續?")) {
        return respond({ ok: false, error: "已取消。可以多點 1~2 張公共牌(轉牌 / 河牌)再解算。" });
      }
      return startJob("solve", JSON.stringify({ spot: req.spot }), req.spot?.iterations || 0);
    }
    if (path === "/api/resolve") {
      const req = body ? JSON.parse(body) : {};
      return startJob("resolve", body, req.iterations || 1000);
    }
    if (path === "/api") {
      if (busy()) return respond({ ok: false, error: "解算進行中(等 status=done 後再操作)" }, 409);
      return respond(await apiCall(body));
    }
    return respond({ ok: false, error: "not found" }, 404);
  };

  // ── 網頁版版面調整 ──
  const css = document.createElement("style");
  css.textContent = `
    #tabbtn-preflop, .gpu-toggle:has(#useGpu), #gpuEst { display: none !important; }
    .web-note { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
      padding: 8px 18px; font-size: 13px; color: var(--ink-dim);
      background: var(--bg1); border-bottom: 1px solid var(--line-strong); }
    .web-note b { color: var(--brass-bright); font-weight: 600; }
    .web-note a { color: var(--brass); text-decoration: none; margin-left: auto; white-space: nowrap; }
    .web-note a:hover { color: var(--brass-bright); }`;
  document.head.appendChild(css);

  document.addEventListener("DOMContentLoaded", () => {
    const note = document.createElement("div");
    note.className = "web-note";
    note.innerHTML = `<span>🌐 <b>瀏覽器版</b>:Rust 引擎編成 WebAssembly,直接在你的電腦上解算(無 GPU)。
      建議點 <b>4~5 張公共牌</b>解轉牌 / 河牌,翻牌寬範圍會很慢。</span>
      <a href="../../">← 回作品集</a>`;
    document.querySelector(".topbar")?.after(note);
  });

  // 預設牌面補到河牌(app.js 預設 Td9d6h 翻牌在瀏覽器版太慢;Qc 2s → 一按即解)
  window.addEventListener("load", () => {
    if (typeof S === "undefined" || typeof renderBoardPicker !== "function") return;
    if (S.board.length === 3) {
      S.board.push(cardIdx("Q", "c"), cardIdx("2", "s"));
      renderBoardPicker();
    }
  });
})();
