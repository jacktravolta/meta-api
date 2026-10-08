// abrir-botest.mjs — busca "BOTEST" en la lista lateral y abre ese chat.
//
// Guard de canal: el candidato de la lista se valida CONTRA EL PROPIO TEXTO DE
// LA FILA antes de ningun click, y una vez abierto se vuelve a validar el
// titulo del header. Si alguno de los dos no esta en la lista blanca, sale
// con codigo 1 sin hacer click (fail-closed).
import { canalPermitido, motivoRechazo } from "../relay/canal-ok.mjs";

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
// 2) click en el primer resultado — el nombre visible de la fila se valida
// ANTES de cualquier Input.dispatchMouseEvent. El textContent puede venir
// prefijado por un icono (ic-group-filled), asi que se descarta ese token y se
// toma la primera linea no vacia del nombre visible. Ojo: el token se compara
// SIN /i, porque con mayusculas `[a-z-]+` se tragaria el propio nombre.
const res = await q(`(() => { const el = [...document.querySelectorAll('#pane-side [role=listitem], #pane-side [role=row], div[role=listitem]')].find(e => (e.innerText||'').includes('BOTEST')); if(!el) return null; const r=el.getBoundingClientRect(); const lineas=(el.innerText||el.textContent||'').split('\\n').map(s=>s.trim().replace(/^ic-[a-z-]+\\s*/,'').trim()).filter(Boolean); return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),nombre:lineas[0]||''}); })()`);
console.log("resultado:", res);
if (res) {
  const r2 = JSON.parse(res);
  if (!canalPermitido(r2.nombre)) {
    console.log(`BLOQUEADO: ${motivoRechazo(r2.nombre)} — no se hace click en el resultado`);
    process.exit(1);
  }
  for (const type of ["mouseMoved","mousePressed","mouseReleased"]) await call("Input.dispatchMouseEvent",{type,x:r2.x,y:r2.y,button:"left",clickCount:1});
  await sleep(2500);
}
console.log("main abierto:", await q(`!!document.querySelector('#main')`));
// 3) verificacion final: el chat que quedo abierto tiene que ser un canal
// permitido; si no, el script falla en lugar de dar por buena la apertura.
const titulo = await q(`document.querySelector('#main header span[dir=auto]')?.textContent?.trim() || null`);
console.log("titulo:", titulo);
if (!canalPermitido(titulo)) {
  console.log(`BLOQUEADO: ${motivoRechazo(titulo)} — el chat abierto no es un canal permitido`);
  process.exit(1);
}
process.exit(0);
