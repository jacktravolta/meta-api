const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
// 1) buscar
const caja = await q(`(() => { const e = document.querySelector('#side [contenteditable=true], #side input, div[title="Buscar"]'); if(!e) return null; const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`);
console.log("caja de busqueda:", caja);
if (!caja) process.exit(1);
const c = JSON.parse(caja);
for (const type of ["mouseMoved","mousePressed","mouseReleased"]) await call("Input.dispatchMouseEvent",{type,x:c.x,y:c.y,button:"left",clickCount:1});
await sleep(500);
await call("Input.insertText", { text: "BOTEST" });
await sleep(2500);
// 2) click en el primer resultado
const res = await q(`(() => { const el = [...document.querySelectorAll('#pane-side [role=listitem], #pane-side [role=row], div[role=listitem]')].find(e => (e.innerText||'').includes('BOTEST')); if(!el) return null; const r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`);
console.log("resultado:", res);
if (res) {
  const r2 = JSON.parse(res);
  for (const type of ["mouseMoved","mousePressed","mouseReleased"]) await call("Input.dispatchMouseEvent",{type,x:r2.x,y:r2.y,button:"left",clickCount:1});
  await sleep(2500);
}
console.log("main abierto:", await q(`!!document.querySelector('#main')`));
console.log("titulo:", await q(`document.querySelector('#main header span[dir=auto]')?.textContent || null`));
process.exit(0);
