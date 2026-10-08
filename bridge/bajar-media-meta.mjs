// bajar-media-meta.mjs — rescata la multimedia de la ULTIMA respuesta de Meta
// (imagenes generadas en la fila del asistente) y la escribe a un archivo local.
// Devuelve la RUTA del archivo por stdout en JSON, para que el relay arme el
// mensaje clon hacia WhatsApp.
//
// Tecnica (misma que el relay de WhatsApp): CDP Runtime.evaluate en la pagina,
// se bajan los bytes DESDE EL CONTEXTO DE LA PAGINA. Para las imagenes de Meta
// (fbcdn) funciona `fetch(url)` plano: con `credentials:"include"` da CORS y
// canvas.toDataURL() sale contaminado.
//
// Uso:
//   node bajar-media-meta.mjs            -> ultima fila del asistente
//   node bajar-media-meta.mjs --todas    -> todas las filas con media
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const MEDIA_DIR = join(BIN, "..", "relay", "state", "media-meta");
const canal = existsSync(CANAL) ? JSON.parse(readFileSync(CANAL, "utf8")) : null;
if (!canal) { console.log(JSON.stringify({ ok: false, porque: "sin canal.json" })); process.exit(2); }
mkdirSync(MEDIA_DIR, { recursive: true });

const TODAS = process.argv.includes("--todas");

const lista = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = lista.find((x) => (x.url || "").includes(canal.id));
if (!t) { console.log(JSON.stringify({ ok: false, porque: "no hay pestana del canal" })); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result?.result?.value); pend.delete(m.id); } };
const call = (method, params) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => r(undefined), 40000); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (expr) => await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });

// Extrae las imagenes de contenido de las filas del asistente y las devuelve
// como { mime, b64 } (se bajan DENTRO de la pagina). Excluye el logo de UI.
const EXPR = (todas) => `(async () => {
  const rows = [...document.querySelectorAll('[class*="group/message-row"]')]
    .filter(r => r.querySelector('[data-testid="assistant-message"]'));
  const alcance = ${todas ? "rows" : "rows.slice(-1)"};
  const salida = [];
  for (const r of alcance) {
    const imgs = [...r.querySelectorAll('[data-testid="assistant-message"] img')]
      .filter(e => (e.naturalWidth || 0) > 200 && !/cot_logo_static/.test(e.currentSrc || e.src || ""));
    for (const e of imgs) {
      const url = e.currentSrc || e.src;
      try {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let s = "";
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        salida.push({ mime: resp.headers.get("content-type") || "image/png", size: bytes.length, b64: btoa(s) });
      } catch (err) { salida.push({ error: String(err && err.message || err), url: url.slice(0, 80) }); }
    }
  }
  return JSON.stringify(salida);
})()`;

let datos = [];
try { datos = JSON.parse((await q(EXPR(TODAS))) || "[]"); } catch (e) { datos = []; }
const ok = datos.filter((d) => d.b64);
const extDe = (mime) => /jpeg|jpg/.test(mime) ? "jpg" : /webp/.test(mime) ? "webp" : /gif/.test(mime) ? "gif" : "png";
const paths = [];
const stamp = Date.now();
ok.forEach((d, i) => {
  const p = join(MEDIA_DIR, `meta-${stamp}-${i}.${extDe(d.mime)}`);
  try { writeFileSync(p, Buffer.from(d.b64, "base64")); paths.push(p); } catch {}
});
console.log(JSON.stringify({ ok: paths.length > 0, count: paths.length, paths, errores: datos.filter((d) => d.error) }, null, 1));
try { ws.close(); } catch {}
process.exit(paths.length ? 0 : 1);
