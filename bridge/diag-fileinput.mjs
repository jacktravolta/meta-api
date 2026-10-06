const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("meta.ai"));
if (!t) { console.log("no tab meta"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
console.log("inputs file en el hilo de Meta:", await q(`document.querySelectorAll('input[type=file]').length`));
console.log("detalle:", await q(`JSON.stringify([...document.querySelectorAll('input[type=file]')].map(e=>({accept:e.accept, multiple:e.multiple, hidden:e.hidden})))`));
console.log("botones de adjuntar:", await q(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(a=>a && /adjunt|attach|archivo|file|imagen/i.test(a)))`));
process.exit(0);
