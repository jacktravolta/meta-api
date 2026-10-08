// diag-descarga.mjs — click derecho en el mensaje de audio para diagnosticar
// el menu de descarga.
//
// Guard de canal: se valida el titulo del chat abierto ANTES de cualquier
// Input.dispatchMouseEvent; sin canal en la lista blanca no se hace click
// derecho (fail-closed).
import { canalPermitido, motivoRechazo } from "../relay/canal-ok.mjs";

const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(()=>r(undefined),15000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
// (guard) Titulo del chat abierto, validado antes de cualquier evento de raton.
const titulo = await q(`document.querySelector('#main header span[dir=auto]')?.textContent?.trim() || null`);
if (!canalPermitido(titulo)) {
  console.log(`BLOQUEADO: ${motivoRechazo(titulo)} — no se hace click derecho en el chat`);
  process.exit(1);
}
// click derecho en el primer mensaje con boton de reproducir
const pos = await q(`(() => { const b=[...document.querySelectorAll('#main [aria-label*="eproducir"]')].pop(); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); })()`);
console.log("posicion:", pos);
if (pos) {
  const c = JSON.parse(pos);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "right", buttons: 2, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "right", buttons: 0, clickCount: 1 });
  await sleep(1500);
  console.log("menu (items):", await q(`JSON.stringify([...document.querySelectorAll('[role=menuitem], [role=button]')].map(e=>(e.textContent||'').trim()).filter(t=>t).slice(0,10))`));
}
process.exit(0);
