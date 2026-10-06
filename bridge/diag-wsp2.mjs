const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no tab"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
console.log("logueado:", await q(`!!document.querySelector('#pane-side')`));
console.log("pane-side existe:", await q(`!!document.querySelector('#pane-side')`));
console.log("filas pane-side:", await q(`document.querySelectorAll('#pane-side [role=row], #pane-side [role=listitem]').length`));
console.log("contiene BOTEST:", await q(`[...document.querySelectorAll('#pane-side *')].some(e => (e.innerText||'').includes('BOTEST'))`));
console.log("primeros textos:", await q(`JSON.stringify([...document.querySelectorAll('#pane-side [role=row]')].slice(0,5).map(e => (e.innerText||'').split('\\n').filter(Boolean)[0] || ''))`));
console.log("main abierto:", await q(`!!document.querySelector('#main')`));
process.exit(0);
