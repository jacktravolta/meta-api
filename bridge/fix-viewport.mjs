const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no tab"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
// Forzar metricas de dispositivo limpias -> la app re-hace el layout.
await call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(2500);
console.log("viewport:", await q("window.innerWidth + 'x' + window.innerHeight"));
console.log("#side rect:", await q(`(() => { const e=document.querySelector('#side'); if(!e) return null; const r=e.getBoundingClientRect(); return JSON.stringify({top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)}); })()`));
console.log("caja de busqueda:", await q(`(() => { const e = document.querySelector('#side [contenteditable=true], #side input, div[title="Buscar"]'); if(!e) return null; const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`));
process.exit(0);
