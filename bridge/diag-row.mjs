const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
console.log("rect de la fila BOTEST:", await q(`(() => {
  const cont = document.querySelector('#pane-side');
  if (!cont) return 'no pane-side';
  const rows = [...cont.querySelectorAll('[role="row"], [data-testid^="list-item"]')];
  const row = rows.find(r => (r.textContent || '').includes('BOTEST'));
  if (!row) return 'no encontre fila con BOTEST';
  const r = row.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) });
})()`));
console.log("pane-side rect:", await q(`(() => { const e = document.querySelector('#pane-side'); const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}); })()`));
process.exit(0);
