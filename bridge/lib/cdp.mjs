// lib/cdp.mjs — primitivas ROBUSTAS de automatización "clon humano" por CDP.
//
// HOMOLOGADO del proyecto cdpAutoCura (ver /home/test/cdpAutoCura/lib/cdp.mjs).
// En el donbot se usa SOLO como capa de respaldo: el selector principal se evalúa
// primero; el Resolutor entra únicamente cuando el principal devuelve null.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

export const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** Conecta a un target por subcadena de URL (filtra type=page). Opcional: abrir. */
export async function conectar(cdp, urlMatch, { nuevo, timeout = 8000 } = {}) {
  const lista = await (await fetch(`${cdp}/json`)).json();
  let t = lista.find((x) => x.type === "page" && (x.url || "").includes(urlMatch));
  if (!t && nuevo) t = await (await fetch(`${cdp}/json/new?${encodeURIComponent(nuevo)}`, { method: "PUT" })).json();
  if (!t) throw new Error("no hay pestaña para " + urlMatch);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, timeout); });
  let id = 1; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const call = (method, params) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => r(undefined), 25000); });
  return { ws, call };
}

export async function ev(call, expr) { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : undefined; }

/** Espera (poll) hasta que `cond` (string JS) sea true. Devuelve true/false. */
export async function esperar(call, cond, ms = 8000, paso = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(call, cond)) return true; await sleep(paso); }
  return false;
}
