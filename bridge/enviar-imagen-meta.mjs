// enviar-imagen-meta.mjs — sube una imagen AL HILO DE META (no a WhatsApp).
// Usa el input[type=file] del composer de Meta via CDP DOM.setFileInputFiles.
// Uso: node enviar-imagen-meta.mjs /ruta/imagen.png ["texto opcional"]
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// HOMOLOGADO cdpAutoCura: el Resolutor es SOLO un fallback. El selector principal
// se evalúa primero; el Resolutor entra únicamente cuando el principal devuelve null.
import { Resolutor, Telemetria } from "./lib/resolver.mjs";
const BIN = dirname(fileURLToPath(import.meta.url));
const canal = existsSync(join(BIN, "canal.json")) ? JSON.parse(readFileSync(join(BIN, "canal.json"), "utf8")) : null;
if (!canal) { console.log("sin canal.json"); process.exit(2); }
const RUTA = process.argv[2];
const TEXTO = process.argv[3] || "";
if (!RUTA || !existsSync(RUTA)) { console.log("falta la imagen"); process.exit(2); }

const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes(canal.id));
if (!t) { console.log("no hay pestaña del canal"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 20000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

// ── HOMOLOGADO cdpAutoCura: Resolutor como capa de respaldo (solo fallback) ──
const teleImgMeta = new Telemetria("donbot-enviar-imagen-meta", join(BIN, "telemetria-img-meta.jsonl"));
let resolImgMeta = null;
const MAPA_DONBOT_URL = process.env.MAPA_DONBOT_URL || "http://127.0.0.1:8799/donbot-selectors.json";
const SPEC_INPUT_FILE_META = {
  sel: "input[type=file]",
  rx: /attach|adjunt|file|subir/i,
  anclas: ["input[type=file][accept*='image']", "input[type=file]", "input[accept*='image']"],
  masGrande: false,
};

await call("DOM.enable");
await call("Page.enable");
// ORDEN IMPORTANTE (diagnostico de Meta): el TEXTO se escribe ANTES de setear el
// archivo. Si se sube primero el archivo, Meta lo ve y responde al toque, sin
// contexto. Con el texto ya puesto, salen juntos en un solo mensaje.
if (TEXTO) {
  await call("Runtime.evaluate", { expression: `(() => { const el=document.querySelector('[data-testid="composer-input"][contenteditable="true"]'); if(!el) return false; el.focus(); return true; })()`, returnByValue: true });
  await sleep(500);
  await call("Input.insertText", { text: TEXTO });
  await sleep(800);
}
// Si la pagina de Meta degrado (sin file input), RECARGAR el hilo y reintentar.
let nodeId = null;
async function buscarInput() {
  const doc = await call("DOM.getDocument", { depth: -1, pierce: true });
  const rootId = doc && doc.root ? doc.root.nodeId : null;
  if (!rootId) return null;
  const q = await call("DOM.querySelector", { nodeId: rootId, selector: 'input[type=file]' });
  return q && q.nodeId ? q.nodeId : null;
}
nodeId = await buscarInput();
if (!nodeId) {
  console.log("sin file input: recargo el hilo de Meta y reintento");
  await call("Page.navigate", { url: "https://www.meta.ai/prompt/" + canal.id });
  await sleep(16000);
  nodeId = await buscarInput();
}
// HOMOLOGADO cdpAutoCura: si el selector principal falló, el Resolutor intenta
// resolver el input[type=file] por anclas. NO destructivo.
if (!nodeId) {
  if (!resolImgMeta) resolImgMeta = new Resolutor(call, { app: "donbot-enviar-imagen-meta", version: "1", mapaUrl: MAPA_DONBOT_URL, telemetria: teleImgMeta });
  const r = await resolImgMeta.resolver("input-file-meta", SPEC_INPUT_FILE_META);
  if (r) {
    const doc2 = await call("DOM.getDocument", { depth: -1, pierce: true });
    const rootId2 = doc2 && doc2.root ? doc2.root.nodeId : null;
    if (rootId2) {
      const q2 = await call("DOM.querySelector", { nodeId: rootId2, selector: r.selector });
      if (q2 && q2.nodeId) { nodeId = q2.nodeId; console.log(`input[type=file] resuelto por el Resolutor (via: ${r.via})`); }
    }
  }
}
if (!nodeId) { console.log("no encontre input[type=file] tras recargar"); process.exit(1); }

await call("DOM.setFileInputFiles", { files: [RUTA], nodeId });
console.log("archivo seteado: " + RUTA);
await sleep(3000 + Math.floor(Math.random() * 3000));   // jitter (recomendacion de Meta)
let enviado = false;
for (let k = 0; k < 4 && !enviado; k++) {
  await call("Runtime.evaluate", { expression: `(() => { const b=document.querySelector('[data-testid="composer-send-button"]'); if(b && !b.disabled){ b.click(); return true; } return false; })()`, returnByValue: true });
  await sleep(3000);
  const r = await call("Runtime.evaluate", { expression: `(() => { const b=document.querySelector('[data-testid="composer-send-button"]'); return b ? b.disabled : null; })()`, returnByValue: true });
  if (r && r.result && r.result.value === true) enviado = true;
}
console.log(enviado ? "IMAGEN ENVIADA A META ✓" : "no se pudo confirmar el envio");
// Registrar el envio (con turno) para que el vigia no lo tome como dictado propio.
if (enviado && TEXTO) {
  try {
    const ENVIADOS = join(BIN, "don-bot-enviados.txt");
    let turno = 0;
    try { turno = JSON.parse(readFileSync(join(BIN, "turno.json"), "utf8")).n || 0; } catch {}
    appendFileSync(ENVIADOS, turno + "|" + TEXTO + "\n");
  } catch {}
}
process.exit(enviado ? 0 : 1);
