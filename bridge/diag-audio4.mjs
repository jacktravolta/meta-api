const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map(); const evs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); return; }
  if (m.method) evs.push(m.method + (m.params?.response?.url ? ' :: ' + String(m.params.response.url).slice(0,70) + ' [' + (m.params.response.mimeType||'') + ']' : ''));
};
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(()=>r(undefined),15000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
await call("Network.enable", {});
await sleep(500);
evs.length = 0;
console.log("play:", await q(`(() => { const bs=[...document.querySelectorAll('#main [aria-label*="eproducir"]')]; const b=bs[0]; if(!b) return 'sin boton'; b.click(); return 'ok'; })()`));
await sleep(7000);
console.log("=== EVENTOS DE RED (" + evs.length + ") ===");
const uniq = [...new Set(evs)];
uniq.slice(0, 25).forEach(e => console.log("  " + e));
process.exit(0);
