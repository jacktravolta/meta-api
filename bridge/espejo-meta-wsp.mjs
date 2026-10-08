// espejo-meta-wsp.mjs — ESPEJO: relaya SOLO la MULTIMEDIA que Meta genera en su
// hilo (imagenes/archivos), con el prefijo [META]. El TEXTO de Meta NO se relaya
// aca: lo entrega el relay de WhatsApp como "🧠 [META]". Antes el espejo tambien
// mandaba el texto, y cada respuesta llegaba DUPLICADA (✨ y 🧠).
//   * Vigila las filas de ASISTENTE (Meta) del hilo de canal.json.
//   * Baseline silencioso al arrancar (salvo el ultimo mensaje).
//   * Ignora lo nuestro ([DON BOT]/[META] propios) y ruido de UI.
//   * De cada fila nueva rescata la imagen mas grande (fetch en el contexto de la
//     pagina) y la manda a WhatsApp. Las filas SIN media se ignoran.
//     El caption es CLAVE: el relay de WhatsApp descarta por etiqueta propia, y
//     asi no se contesta a si mismo (evita el bucle).
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const VISTOS = join(BIN, "espejo-vistos.json");
const LOG = join(BIN, "espejo-log.txt");
const ENVIAR_MEDIA = join(BIN, "enviar-media-wsp.mjs");
const MEDIA_DIR = join(BIN, "..", "relay", "state", "media-meta");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(MEDIA_DIR, { recursive: true });

if (!existsSync(CANAL)) { console.log("sin canal.json"); process.exit(2); }
const canal = JSON.parse(readFileSync(CANAL, "utf8"));
const norm = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 300).toLowerCase();
const ruido = [/^mostrar razonamiento/, /^ocultar razonamiento/, /^transcribir audio o video/, /^hoy$/, /lineas? ocultas?/, /^pensando/];

let vistos = new Set(existsSync(VISTOS) ? JSON.parse(readFileSync(VISTOS, "utf8")) : []);
const guardar = () => writeFileSync(VISTOS, JSON.stringify([...vistos].slice(-400)));
// Imagenes ya relayadas (por src): evita mandar la MISMA imagen 2-3 veces cuando
// el texto de la respuesta de Meta crece por streaming (cada etapa tiene un texto
// distinto, asi que el dedup por texto no alcanza: se veian 3 fotos iguales).
const VISTOS_IMG = join(BIN, "espejo-vistos-img.json");
let vistosImg = new Set(existsSync(VISTOS_IMG) ? JSON.parse(readFileSync(VISTOS_IMG, "utf8")) : []);
const guardarImg = () => writeFileSync(VISTOS_IMG, JSON.stringify([...vistosImg].slice(-400)));

async function conectar() {
  const l = await (await fetch("http://127.0.0.1:9233/json")).json();
  // El hilo de Meta puede cambiar de id (meta-api abre/retoma otro /prompt/<uuid>)
  // y canal.json queda viejo. Antes, si el id fijado no estaba, el espejo moria
  // con "no hay pestaña del canal" y systemd lo reiniciaba en bucle. Se prefiere
  // el canal fijado; si no esta, se usa la primera pestaña de meta.ai/prompt.
  const t = l.find((x) => (x.url || "").includes(canal.id))
    || l.find((x) => x.type === "page" && /meta\.ai\/prompt\//.test(x.url || ""));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
  let i = 1; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
  const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 20000); });
  return { ws, call };
}
const enviarMediaWsp = (ruta, caption) => {
  try { execFileSync(process.execPath, [ENVIAR_MEDIA, ruta, caption], { stdio: "ignore", timeout: 150000, env: { ...process.env, WSP_CDP: "http://127.0.0.1:9233" } }); return true; }
  catch { return false; }
};

let { ws, call } = (await conectar()) || {};
if (!ws) { console.log("no hay pestaña del canal"); process.exit(1); }
console.log("== espejo Meta->WhatsApp activo (solo multimedia) ==");

// Rescata una imagen de la respuesta de Meta: fetch DENTRO de la pagina y la
// escribe a un archivo. Devuelve la ruta o null.
async function bajarImagen(src) {
  const b64 = await call("Runtime.evaluate", {
    expression: `(async () => { try { const r = await fetch(${JSON.stringify(src)}); const b = await r.arrayBuffer(); const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); } catch (e) { return null; } })()`,
    returnByValue: true, awaitPromise: true,
  });
  if (!b64 || typeof b64 !== "string") return null;
  const ext = /\.png(\?|$)/i.test(src) ? "png" : /\.webp(\?|$)/i.test(src) ? "webp" : "jpg";
  const p = join(MEDIA_DIR, `meta-${Date.now()}-${Math.floor(Math.random() * 1e4)}.${ext}`);
  try { writeFileSync(p, Buffer.from(b64, "base64")); return p; } catch { return null; }
}

let primerCiclo = true;
let prevRows = new Set();   // estabilidad: evita relayer mientras el texto crece
for (let k = 0; k < 86400; k++) {
  if (!ws || ws.readyState !== 1) { const c = await conectar().catch(() => null); if (c) ({ ws, call } = c); await sleep(5000); continue; }
  let rows = [];
  try {
    rows = JSON.parse((await call("Runtime.evaluate", {
      expression: `JSON.stringify([...document.querySelectorAll('[class*="group/message-row"]')]
        .filter(r => r.querySelector('[data-testid="assistant-message"]'))
        .map(r => ({
          t: (r.innerText||'').replace(/\\n+/g,' ').replace(/(?:mostrar|ocultar|show|hide)\\s+razonamiento/gi,'').trim(),
          imgs: [...r.querySelectorAll('[data-testid="assistant-message"] img')]
            .filter(e => (e.naturalWidth||0) > 200 && !/cot_logo_static/.test(e.currentSrc||e.src||''))
            .map(e => ({ src: e.currentSrc||e.src, w: e.naturalWidth||0, h: e.naturalHeight||0 })),
        }))
        .filter(x => x.t)
        .slice(-10))`,
      returnByValue: true,
    })) || "[]");
  } catch {}
  if (!Array.isArray(rows)) rows = [];
  const rowsNorm = rows.map((r) => norm(r.t));

  if (primerCiclo && rows.length) {
    for (const n of rowsNorm.slice(0, -1)) vistos.add(n);
    guardar();
    primerCiclo = false;
  } else {
    for (const row of rows) {
      const n = norm(row.t);
      if (vistos.has(n)) continue;
      // ESTABILIDAD: solo relayar si el texto YA estaba en la lectura anterior.
      if (!prevRows.has(n)) continue;
      vistos.add(n);
      if (/^\s*(?:[^\[A-Za-z0-9]{1,4}\s*)?\[(don\s?bot|donbot|meta)\]/i.test(row.t.trim())) { continue; }   // nuestro
      if (ruido.some((rx) => rx.test(n))) { continue; }
      // SOLO MULTIMEDIA: el espejo existe para las imagenes/archivos que Meta
      // genera (el relay NO relaya media). El TEXTO de Meta lo entrega el relay
      // como "🧠 [META]"; si el espejo tambien lo mandaba, cada respuesta llegaba
      // DUPLICADA (✨ y 🧠). Regla del usuario (2026-10-08): el espejo, solo media.
      // Imagen mas grande de la fila (la generada por Meta, no el eco original).
      const imgs = (row.imgs || []).slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
      const mejor = imgs[0];
      if (!mejor || !mejor.src) { continue; }        // sin media: no se relaya
      if (vistosImg.has(mejor.src)) { continue; }    // ya relayada (el texto crece por streaming)
      const texto = "✨ [META] " + row.t.replace(/\s+/g, " ").trim().slice(0, 900);
      vistosImg.add(mejor.src); guardarImg();
      const ruta = await bajarImagen(mejor.src);
      if (!ruta) { continue; }
      const ok = enviarMediaWsp(ruta, texto);
      appendFileSync(LOG, `[${new Date().toISOString()}] ${ok ? "media" : "FALLO-media"}: ${ruta} :: ${texto.slice(0, 70)}\n`);
      console.log((ok ? "→ WhatsApp (imagen): " : "FALLO imagen: ") + texto.slice(0, 70));
    }
    guardar();
  }
  prevRows = new Set(rowsNorm);
  await sleep(3000);
}
