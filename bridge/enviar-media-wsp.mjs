// enviar-media-wsp.mjs — envia un ARCHIVO (imagen) a WhatsApp Web, con caption.
//
// Flujo (DOM real de WhatsApp Web, descubierto en vivo):
//   1) DOM.setFileInputFiles -> abre el VISOR de media
//   2) caption: se tipea en el composer del visor (el editor lo usa como pie)
//   3) click en el boton de enviar DEL VISOR: [data-testid="wds-ic-send-filled"]
//
// El caption importa: si empieza con la etiqueta propia ("✨ [META] ..."), el
// relay de WhatsApp lo descarta y NO se contesta a si mismo (evita bucle).
//
// Guard de canal fail-closed.
// Uso: node enviar-media-wsp.mjs /ruta/imagen.png ["caption opcional"]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canalPermitido, motivoRechazo } from "../relay/canal-ok.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
let RUTA = process.argv[2];
const CAPTION = process.argv[3] || "";
if (!RUTA || !existsSync(RUTA)) { console.log(JSON.stringify({ ok: false, porque: "archivo inexistente: " + RUTA })); process.exit(2); }
// WhatsApp Web NO adjunta bien los WEBP por el flujo de FOTO (el visor se cierra
// como "enviado" pero no aparece imagen; verificado 2026-10-08: el mismo archivo
// en JPG si entra). Se convierten a JPG con ImageMagick antes de inyectarlos.
if (/\.webp$/i.test(RUTA)) {
  const tmp = join("/tmp/opencode", "wsp-" + Date.now() + "-" + Math.floor(Math.random() * 1e4) + ".jpg");
  const r = spawnSync("convert", [RUTA, tmp], { stdio: "ignore" });
  if (r.status === 0 && existsSync(tmp)) RUTA = tmp;
  else { console.log(JSON.stringify({ ok: false, porque: "no pude convertir webp->jpg (ImageMagick)" })); process.exit(1); }
}

const lista = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = lista.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log(JSON.stringify({ ok: false, porque: "no hay pestana de WhatsApp" })); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const call = (method, params) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => r(undefined), 20000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const ev = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : null; };

// (1) GUARD.
let titulo = null;
for (let i = 0; i < 4 && !canalPermitido(titulo); i++) { if (i) await sleep(700); titulo = await ev(`document.querySelector('#main header span[dir=auto]')?.textContent?.trim() || null`); }
if (!canalPermitido(titulo)) { console.log(JSON.stringify({ ok: false, porque: "BLOQUEADO: " + motivoRechazo(titulo) })); process.exit(1); }

// (2) adjuntar INYECTANDO el archivo con JS puro (base64 -> DataTransfer ->
// evento change). NO se usa DOM.setFileInputFiles: en este Chrome (beta 149)
// ese comando del dominio DOM hacia crashear el renderer de WhatsApp con
// RESULT_CODE_KILLED_BAD_MESSAGE ("¡Vaya!"). La via JS no toca el dominio DOM.
// Id de la ultima fila ANTES de enviar: sirve para verificar que el envio agrego
// un mensaje NUEVO y no registrar como "propio" uno viejo (bug real: un envio
// fallido registro el id del ultimo mensaje anterior y el relay lo salteaba).
const antesId = await ev(`(() => { const rows = [...document.querySelectorAll('#main [role=row]')].filter(f => f.querySelector('[data-id]')); const last = rows[rows.length - 1]; return last ? last.querySelector('[data-id]').getAttribute('data-id') : null; })()`);
const b64 = readFileSync(RUTA).toString("base64");
const mime = /\.png$/i.test(RUTA) ? "image/png" : /\.webp$/i.test(RUTA) ? "image/webp" : "image/jpeg";
const nombreArch = RUTA.split("/").pop();
const inyRes = await call("Runtime.evaluate", {
  expression: `(async () => {
    try {
      const r = await fetch("data:${mime};base64,${b64}");
      const blob = await r.blob();
      const file = new File([blob], ${JSON.stringify(nombreArch)}, { type: "${mime}" });
      const dt = new DataTransfer(); dt.items.add(file);
      // El PRIMER input[type=file] del DOM es el de STICKERS (accept="image/*"
      // sin video): inyectar ahi convierte la imagen en sticker 512x512 (la
      // "miniatura" que se veia en WhatsApp). El input de FOTOS lleva video en
      // el accept (image/*,video/mp4,...). Se elige ESE.
      const input = document.querySelector('input[type=file][accept*="video"]')
        || [...document.querySelectorAll('input[type=file]')].find(e => /video/.test(e.getAttribute('accept') || ''))
        || document.querySelector('input[type=file]');
      if (!input) return "sin-input";
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    } catch (e) { return "err:" + e.message; }
  })()`,
  returnByValue: true, awaitPromise: true,
});
const inyectado = inyRes && inyRes.result ? inyRes.result.value : null;
if (inyectado !== "ok") { console.log(JSON.stringify({ ok: false, porque: "inyeccion fallo: " + inyectado })); process.exit(1); }

// (3) esperar el VISOR.
let visor = false;
for (let i = 0; i < 10 && !visor; i++) { await sleep(1000); visor = await ev(`!!document.querySelector('[data-testid="wds-ic-send-filled"]')`); }

// (4) caption: el visor de WhatsApp de esta version NO expone campo de caption
// (verificado en vivo), asi que no se tipea. El anti-bucle del relay ya no
// depende del caption (salta imagenes sin texto por id).

// (5) enviar desde el visor.
let enviado = false;
for (let k = 0; k < 10 && !enviado; k++) {
  const r = await ev(`(() => { const b = document.querySelector('[data-testid="wds-ic-send-filled"]'); if (b) { const t = b.closest('button') || b.parentElement || b; if (t.getBoundingClientRect().width > 0) { t.click(); return 'send-filled'; } } return null; })()`);
  if (r) console.log("click:", r);
  await sleep(2500);
  enviado = !(await ev(`!!(document.querySelector('[data-testid="wds-ic-send-filled"]') || document.querySelector('[data-testid="media-editor-canvas"]'))`));
}
// Registrar el id del mensaje enviado en relay/state/wsp-propios.json para que
// el relay NO lo vuelva a procesar (anti-bucle): una imagen saliente sin texto
// no tiene etiqueta que el filtro por texto pueda reconocer.
if (enviado) {
  try {
    const mid = await ev(`(() => { const rows = [...document.querySelectorAll('#main [role=row]')].filter(f => f.querySelector('[data-id]')); const last = rows[rows.length - 1]; return last ? last.querySelector('[data-id]').getAttribute('data-id') : null; })()`);
    if (mid && mid !== antesId) {
      const f = join(BIN, "..", "relay", "state", "wsp-propios.json");
      let arr = []; try { arr = JSON.parse(readFileSync(f, "utf8")); } catch {}
      if (!Array.isArray(arr)) arr = [];
      if (!arr.includes(mid)) arr.push(mid);
      writeFileSync(f, JSON.stringify(arr.slice(-500)));
      console.log("registrado propio:", mid);
    }
  } catch {}
}
// Verificar que la imagen REALMENTE se adjunto: el ultimo mensaje debe tener una
// imagen GRANDE (no el gif 1x1 placeholder de WhatsApp). Sin esto el sender
// reportaba ok aunque la imagen no hubiera entrado (falso positivo).
let adjuntada = false;
if (enviado) {
  for (let i = 0; i < 6 && !adjuntada; i++) {
    await sleep(1500);
    adjuntada = await ev(`(() => { const rows = [...document.querySelectorAll('#main [role=row]')].filter(f => f.querySelector('[data-id]')); const last = rows[rows.length - 1]; if (!last) return false; return [...last.querySelectorAll('img')].some(e => e.naturalWidth > 50); })()`);
  }
}
const okFinal = enviado && adjuntada;
// Marcar en el cache de WhatsApp la imagen que acabamos de ENVIAR, para que el
// relay no la re-elija (el cache es COMPARTIDO y el emparejamiento es por
// tiempo: sin esto el relay mandaba a Meta imagenes de envios anteriores).
if (okFinal) {
  try {
    const nuevo = await call("Runtime.evaluate", {
      expression: `(async () => { try {
        const abrir = (n) => new Promise((res, rej) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const db = await abrir("lru-media-storage-idb");
        const meta = await new Promise((res) => { const q = db.transaction("lru-media-meta-info","readonly").objectStore("lru-media-meta-info").getAll(); q.onsuccess = () => res(q.result||[]); q.onerror = () => res([]); });
        db.close();
        if (!meta.length) return null;
        const nv = meta.reduce((a,b) => Number(b.timestamp) > Number(a.timestamp) ? b : a);
        return nv && nv.id ? nv.id : null;
      } catch (e) { return null; } })()`,
      returnByValue: true, awaitPromise: true,
    });
    const idNuevo = nuevo && nuevo.result ? nuevo.result.value : null;
    if (idNuevo) {
      const f = join(BIN, "..", "relay", "state", "wsp-medios-vistos.json");
      let obj = { ids: [] }; try { obj = JSON.parse(readFileSync(f, "utf8")); } catch {}
      if (!Array.isArray(obj.ids)) obj.ids = [];
      if (!obj.ids.includes(idNuevo)) obj.ids.push(idNuevo);
      writeFileSync(f, JSON.stringify({ ids: obj.ids.slice(-500) }));
      console.log("marcado en cache:", String(idNuevo).slice(0, 12));
    }
  } catch {}
}
console.log(JSON.stringify({ ok: okFinal, enviado, adjuntada, ruta: RUTA, caption: CAPTION.slice(0, 40), chat: titulo }, null, 1));
try { ws.close(); } catch {}
process.exit(okFinal ? 0 : 1);
