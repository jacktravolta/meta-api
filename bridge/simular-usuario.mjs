// simular-usuario.mjs — escribe y envia un mensaje en WhatsApp como si fuera
// el usuario (sin pasar por el relay, para que NO quede marcado como del bot).
//
// Guard de canal: el destino NO se infiere de "lo que este abierto en la
// pestana". El titulo real del DOM se valida contra la lista blanca ANTES de
// cualquier evento de raton/teclado; si no esta permitido, se sale sin un solo
// Input.* (fail-closed).
import { canalPermitido, motivoRechazo } from "../relay/canal-ok.mjs";

const CDP = process.env.WSP_CDP || "http://127.0.0.1:9233";
const TEXTO = process.argv[2] || "Don Bot, decime la hora";
const l = await (await fetch(CDP + "/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no hay pestaña de WhatsApp"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
async function ev(expr) { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : null; }
// (guard) Se lee el titulo del chat ANTES de tocar el composer. Sin canal en
// la lista blanca no hay click, no hay insertText y no hay Enter.
const titulo = await ev(`(() => { const s = document.querySelector('#main header span[dir=auto]'); return s ? s.textContent.trim() : null; })()`);
if (!canalPermitido(titulo)) {
  console.log(`BLOQUEADO: ${motivoRechazo(titulo)} — no se escribe nada en el composer`);
  process.exit(1);
}
const caja = await ev(`(() => { const e = document.querySelector('#main footer [contenteditable=true]'); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}); })()`);
if (!caja) { console.log("no encontre la caja de texto"); process.exit(1); }
const c = JSON.parse(caja);
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await call("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1 });
await sleep(400);
await call("Input.insertText", { text: TEXTO });
await sleep(700);
for (const t2 of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type: t2, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
console.log("simulado como usuario: " + TEXTO);
process.exit(0);
