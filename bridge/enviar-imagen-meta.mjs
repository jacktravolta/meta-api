// enviar-imagen-meta.mjs — sube una imagen AL HILO DE META (no a WhatsApp).
// Usa el input[type=file] del composer de Meta via CDP DOM.setFileInputFiles.
// Uso: node enviar-imagen-meta.mjs /ruta/imagen.png ["texto opcional"]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// El composer de Meta puede estar en un iframe? Se busca en TODOS los frames.
const doc = await call("DOM.getDocument", { depth: -1, pierce: true });
const rootId = doc && doc.root ? doc.root.nodeId : null;
let nodeId = null;
if (rootId) {
  const q = await call("DOM.querySelector", { nodeId: rootId, selector: 'input[type=file]' });
  nodeId = q && q.nodeId ? q.nodeId : null;
}
if (!nodeId) { console.log("no encontre input[type=file]"); process.exit(1); }

await call("DOM.setFileInputFiles", { files: [RUTA], nodeId });
console.log("archivo seteado: " + RUTA);
await sleep(3000);   // debounce corto: que el adjunto se registre antes de enviar
let enviado = false;
for (let k = 0; k < 4 && !enviado; k++) {
  await call("Runtime.evaluate", { expression: `(() => { const b=document.querySelector('[data-testid="composer-send-button"]'); if(b && !b.disabled){ b.click(); return true; } return false; })()`, returnByValue: true });
  await sleep(3000);
  const r = await call("Runtime.evaluate", { expression: `(() => { const b=document.querySelector('[data-testid="composer-send-button"]'); return b ? b.disabled : null; })()`, returnByValue: true });
  if (r && r.result && r.result.value === true) enviado = true;
}
console.log(enviado ? "IMAGEN ENVIADA A META ✓" : "no se pudo confirmar el envio");
process.exit(enviado ? 0 : 1);
