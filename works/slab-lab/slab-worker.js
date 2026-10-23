/* ═══════════════════════════════════════════════════════════════════════════
   slab-worker.js — 瀏覽器版「引擎執行緒」(對應 serve.rs engine_loop)
   獨佔 slab_wasm.wasm instance(常駐 SlabGame);主執行緒 shim 以 postMessage 驅動:
     {id, type:"api",     body}  → slab_handle(同步指令)       → {id, json}
     {id, type:"solve",   body}  → slab_solve_begin + 分塊 step  → begin/progress/done 訊息
     {id, type:"resolve", body}  → slab_resolve_begin + 分塊 step
   分塊:依實測耗時自適應(每塊 ~200ms),塊間讓渡事件迴圈。
   wasm32 panic = abort → instance 失效 → 重建(常駐解遺失,回錯誤請使用者重解)。
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const enc = new TextEncoder(), dec = new TextDecoder();
const CHUNK_MS = 200;
let x = null;          // wasm exports
let panicMsg = null;   // env.slab_panic 傳入的最後一則 panic 訊息
let module = null;     // 已編譯模組(重建 instance 免重新下載)

async function load() {
  if (!module) {
    const res = fetch("slab_wasm.wasm");
    module = WebAssembly.compileStreaming
      ? await WebAssembly.compileStreaming(res).catch(async () => WebAssembly.compile(await (await fetch("slab_wasm.wasm")).arrayBuffer()))
      : await WebAssembly.compile(await (await res).arrayBuffer());
  }
  const inst = await WebAssembly.instantiate(module, {
    env: {
      slab_panic(ptr, len) {
        panicMsg = dec.decode(new Uint8Array(x.memory.buffer, ptr, len).slice());
      },
    },
  });
  x = inst.exports;
  x.slab_init();
}

const out = () => dec.decode(new Uint8Array(x.memory.buffer, x.slab_out_ptr(), x.slab_out_len()).slice());

/** 寫入字串 → 呼叫 export(ptr,len) → 釋放;回 rc。 */
function callStr(fn, str) {
  const b = enc.encode(str || "");
  const p = x.slab_alloc(b.length);
  new Uint8Array(x.memory.buffer, p, b.length).set(b);
  try { return x[fn](p, b.length); }
  finally { try { x.slab_free(p, b.length); } catch {} }
}

/** wasm trap(panic / 記憶體不足)→ 重建 instance,回可讀錯誤 JSON 字串。 */
async function crashed(e) {
  const why = panicMsg || (String(e && e.message || e).includes("unreachable")
    ? "記憶體不足或引擎內部錯誤" : String(e && e.message || e));
  panicMsg = null;
  await load();
  return JSON.stringify({ ok: false, error: `引擎錯誤:${why}(引擎已重新啟動,請重新解算)` });
}

const yieldLoop = () => new Promise(r => setTimeout(r, 0));

async function runJob(id, beginFn, body) {
  let rc;
  try { rc = callStr(beginFn, body); }
  catch (e) { postMessage({ id, type: "begin", json: await crashed(e) }); return; }
  if (rc !== 0) { postMessage({ id, type: "begin", json: out() }); return; }
  postMessage({ id, type: "begin", json: out() });

  let n = 1;
  for (;;) {
    const t0 = performance.now();
    try { rc = x.slab_step(n); }
    catch (e) { postMessage({ id, type: "done", json: await crashed(e) }); return; }
    if (rc === 2 || rc === 1) { postMessage({ id, type: "done", json: out() }); return; }
    postMessage({ id, type: "progress", json: out() });
    const dt = performance.now() - t0;
    n = Math.max(1, Math.min(1000, Math.round(n * CHUNK_MS / Math.max(dt, 1))));
    await yieldLoop();
  }
}

const ready = load();

onmessage = async ({ data: m }) => {
  try { await ready; }
  catch (e) {
    postMessage({ id: m.id, type: m.type === "api" ? "api" : "begin",
      json: JSON.stringify({ ok: false, error: "載入 WebAssembly 失敗:" + e.message }) });
    return;
  }
  if (m.type === "api") {
    let json;
    try { callStr("slab_handle", m.body); json = out(); }
    catch (e) { json = await crashed(e); }
    postMessage({ id: m.id, type: "api", json });
  } else if (m.type === "solve") {
    runJob(m.id, "slab_solve_begin", m.body);
  } else if (m.type === "resolve") {
    runJob(m.id, "slab_resolve_begin", m.body);
  }
};
