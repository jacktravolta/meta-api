// podar-meta.mjs — PODA el historial renderizado del hilo de Meta.
// Recomendacion 4 de Meta: su SPA acumula nodos (a los 200-300 mensajes el arbol
// de render llega a ~1.5GB y crashea). Ella solo necesita los ultimos ~20
// mensajes para contexto. Esto DETACHA las filas viejas del DOM.
// Uso: node podar-meta.mjs [conservar=30]
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CONSERVAR = Number(process.argv[2] || 30);
const LOG = join(BIN, "podar-meta.log");
const canal = existsSync(join(BIN, "canal.json")) ? JSON.parse(readFileSync(join(BIN, "canal.json"), "utf8")) : null;
if (!canal) { console.log("sin canal.json"); process.exit(2); }

const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes(canal.id));
if (!t) { console.log("no hay pestaña del canal"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 15000); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const r = await call("Runtime.evaluate", {
  expression: `(() => {
    const filas = [...document.querySelectorAll('[class*="group/message-row"]')];
    if (filas.length <= ${CONSERVAR}) return JSON.stringify({ filas: filas.length, podadas: 0 });
    const viejas = filas.slice(0, filas.length - ${CONSERVAR});
    let n = 0;
    for (const f of viejas) { try { f.remove(); n++; } catch (e) {} }
    return JSON.stringify({ filas: filas.length, podadas: n });
  })()`,
  returnByValue: true,
});
const sello = new Date().toISOString();
appendFileSync(LOG, `[${sello}] ${r}\n`);
console.log("poda: " + r);
process.exit(0);
