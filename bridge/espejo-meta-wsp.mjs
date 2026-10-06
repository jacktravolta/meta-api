// espejo-meta-wsp.mjs — ESPEJO: lo que Meta responde en su hilo se relaya solo
// a WhatsApp, con el prefijo [META].
//   * Vigila las filas de ASISTENTE (Meta) del hilo de canal.json.
//   * Baseline silencioso al arrancar (salvo el ultimo mensaje).
//   * Ignora lo nuestro ([DON BOT]/[DONBOT]/[META] propios) y ruido de UI.
//   * Relaya cada respuesta nueva una sola vez (vistos.json propio).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const VISTOS = join(BIN, "espejo-vistos.json");
const LOG = join(BIN, "espejo-log.txt");
const WSP = join(BIN, "..", "relay", "wsp.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CANAL)) { console.log("sin canal.json"); process.exit(2); }
const canal = JSON.parse(readFileSync(CANAL, "utf8"));
const norm = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 300).toLowerCase();
const ruido = [/^mostrar razonamiento/, /^ocultar razonamiento/, /^transcribir audio o video/, /^hoy$/, /lineas? ocultas?/, /^pensando/];

let vistos = new Set(existsSync(VISTOS) ? JSON.parse(readFileSync(VISTOS, "utf8")) : []);
const guardar = () => writeFileSync(VISTOS, JSON.stringify([...vistos].slice(-400)));

async function conectar() {
  const l = await (await fetch("http://127.0.0.1:9233/json")).json();
  const t = l.find((x) => (x.url || "").includes(canal.id));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
  let i = 1; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
  const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 12000); });
  return { ws, call };
}
const enviarWsp = (texto) => {
  const f = join(BIN, "espejo-msg.txt");
  writeFileSync(f, texto);
  try { execFileSync(process.execPath, [WSP, "--enviar", texto], { stdio: "ignore", timeout: 120000, env: { ...process.env, WSP_CDP: "http://127.0.0.1:9233" } }); return true; }
  catch { return false; }
};

let { ws, call } = (await conectar()) || {};
if (!ws) { console.log("no hay pestaña del canal"); process.exit(1); }
console.log("== espejo Meta->WhatsApp activo ==");

let primerCiclo = true;
let prevRows = new Set();   // estabilidad: evita relayer mientras el texto crece
for (let k = 0; k < 86400; k++) {
  if (!ws || ws.readyState !== 1) { const c = await conectar().catch(() => null); if (c) ({ ws, call } = c); await sleep(5000); continue; }
  let rows = [];
  try {
    rows = JSON.parse((await call("Runtime.evaluate", {
      expression: `JSON.stringify([...document.querySelectorAll('[class*="group/message-row"]')].filter(r => r.querySelector('[data-testid="assistant-message"]')).map(r => (r.innerText||'').replace(/\\n+/g,' ').trim()).filter(Boolean).slice(-10))`,
      returnByValue: true,
    })) || "[]");
  } catch {}
  if (!Array.isArray(rows)) rows = [];

  if (primerCiclo && rows.length) {
    for (const t of rows.slice(0, -1)) vistos.add(norm(t));
    guardar();
    primerCiclo = false;
  } else {
    for (const t of rows) {
      const n = norm(t);
      if (vistos.has(n)) continue;
      // ESTABILIDAD: solo relayar si el texto YA estaba en la lectura anterior
      // (WhatsApp/Meta lo escriben creciendo: sin esto se relayaba 3 veces).
      if (!prevRows.has(n)) continue;
      vistos.add(n);
      if (/^\s*(?:[^\[A-Za-z0-9]{1,4}\s*)?\[(don\s?bot|donbot|meta)\]/i.test(t.trim())) { continue; }   // nuestro
      if (ruido.some((rx) => rx.test(n))) { continue; }
      if (t.length < 12) { continue; }
      const texto = "🧠 [META] " + t.replace(/\s+/g, " ").trim().slice(0, 900);
      const ok = enviarWsp(texto);
      appendFileSync(LOG, `[${new Date().toISOString()}] ${ok ? "relayado" : "FALLO"}: ${texto.slice(0, 90)}\n`);
      console.log((ok ? "→ WhatsApp: " : "FALLO al relayar: ") + texto.slice(0, 90));
    }
    guardar();
  }
  prevRows = new Set(rows.map(norm));
  await sleep(3000);
}
