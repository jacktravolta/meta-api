// vigia.mjs — vigia del canal Don Bot.
//   * Descubre el canal via canal.json (lo genera canal.mjs).
//   * Bootstrap: la PRIMERA vez que entra a un canal, publica reglas.txt a Meta.
//   * Detecta dictados: mira filas de usuario Y de asistente (en modo "solo
//     transcribe", la transcripcion puede caer en cualquiera de las dos).
//   * Filtra: firmas [DON BOT] propias, ruido de UI, textos ya vistos,
//     y (si existe el flag) todas las filas de Meta ("Meta callada").
//   * Exige ESTABILIDAD: el texto debe repetirse en 2 lecturas seguidas
//     (evita disparar con transcripciones parciales).
//   * DETECTOR DE SUPLANTACION: firma [DON BOT] que no esta en el registro de
//     envios -> se marca y se loguea en suplantacion.log.
//   * Sale al detectar (una notificacion por dictado). Lectura 2s; recarga 120s.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esDonBot } from "./es-donbot.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const VISTOS = join(BIN, "vistos.json");
const LOG = join(BIN, "dictado-log.txt");
const ENVIADOS = join(BIN, "don-bot-enviados.txt");
const SUPLANT = join(BIN, "suplantacion.log");
const FLAG_META = join(BIN, "ignorar-meta.flag");
const REGLAS = join(BIN, "reglas.txt");
const CDP = "http://127.0.0.1:9233";

let canal = null;
try { canal = existsSync(CANAL) ? JSON.parse(readFileSync(CANAL, "utf8")) : null; } catch {}
if (!canal || !canal.id) { console.log("SIN CANAL: corre primero canal.mjs"); process.exit(2); }
const FRAG = canal.id;
const URL = "https://www.meta.ai/prompt/" + FRAG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (t) => (t || "").replace(/^(?:\S{1,4}\s*)?\[Don Bot\]\s*/i, "").replace(/^don\s?bot[:,]?\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
const pref = (t) => norm(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 50);
const ruido = [/^mostrar razonamiento/, /^ocultar razonamiento/, /^transcribir audio o video/, /^preguntar a meta ai/, /^instant/, /^hoy$/, /lineas? ocultas?/, /^pensando/, /^razonamiento/, /^\[meta\]/, /^\[do[nñ]a meta\]/];

const ROW_EXPR = `JSON.stringify([...document.querySelectorAll('[class*="group/message-row"]')].map(r => ({ rol: r.querySelector('[data-testid="assistant-message"]') ? 'A' : 'U', txt: (r.innerText||'').replace(/\\n+/g,' ').replace(/\\s*Hoy\\s*$/,'').trim() })).filter(x => x.txt.length > 0).slice(-12))`;

const vistos = new Set(existsSync(VISTOS) ? JSON.parse(readFileSync(VISTOS, "utf8")) : []);
for (const l of (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n") : [])) { const t = l.replace(/^\[[^\]]+\]\s*/, "").trim(); if (t) vistos.add(norm(t)); }
for (const l of (existsSync(ENVIADOS) ? readFileSync(ENVIADOS, "utf8").split("\n") : [])) { if (l.trim()) vistos.add(norm(l)); }
const TURNO_F = join(BIN, "turno.json");
const getTurno = () => { try { return JSON.parse(readFileSync(TURNO_F, "utf8")).n || 0; } catch { return 0; } };
const incTurno = () => { const n = getTurno() + 1; try { writeFileSync(TURNO_F, JSON.stringify({ n, ts: new Date().toISOString() })); } catch {} return n; };
// Registro con TURNO: cada linea es "turno|texto". El cotejo es POSICIONAL: un
// mensaje viejo replicado no coincide con el turno actual (diseno de Meta).
let mios = new Set();       // "turno|prefijo"
let miosLegacy = new Set(); // entradas viejas sin turno (compatibilidad)
const recargarMios = () => {
  mios = new Set(); miosLegacy = new Set();
  try {
    for (const l of (existsSync(ENVIADOS) ? readFileSync(ENVIADOS, "utf8").split("\n") : [])) {
      if (!l.trim()) continue;
      const m = l.match(/^(\d+)\|([\s\S]*)$/);
      if (m) mios.add(m[1] + "|" + pref(m[2]));
      else miosLegacy.add(pref(l));
    }
  } catch {}
};
recargarMios();
const esMio = (texto) => { const p = pref(texto); return mios.has(getTurno() + "|" + p) || miosLegacy.has(p); };
const guardarVistos = () => writeFileSync(VISTOS, JSON.stringify([...vistos].slice(-300)));

async function connect() {
  const list = await (await fetch(CDP + "/json")).json();
  let t = list.find((x) => x.type === "page" && (x.url || "").includes(FRAG));
  if (!t) t = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL), { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
  let seq = 1; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result?.result?.value ?? d.error); pending.delete(d.id); } };
  const call = (method, params) => { const id = seq++; return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => res(undefined), 15000); }); };
  return { ws, call };
}

// Bootstrap: primera vez en este canal -> publicar reglas.
if (!canal.bootstrapped) {
  try {
    execFileSync(process.execPath, [join(BIN, "enviar-hilo.mjs"), REGLAS], { stdio: "ignore", timeout: 60000 });
    canal.bootstrapped = true;
    writeFileSync(CANAL, JSON.stringify(canal, null, 1));
    console.log("== bootstrap: reglas del canal publicadas ==");
  } catch (e) { console.log("== bootstrap fallo: " + String(e).slice(0, 120) + " =="); }
}

let { ws, call } = await connect();
try { await call("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
try { await call("Page.setWebLifecycleState", { state: "active" }); } catch {}
console.log("== vigia activo (canal: " + (canal.title || FRAG.slice(0, 8)) + "; 2s lectura + 120s red) ==");

let primerCiclo = true, prevTexts = new Set(), lastReload = Date.now();
for (let i = 0; i < 1800; i++) {
  if (ws.readyState !== 1) { try { ({ ws, call } = await connect()); } catch {} }
  let rows = [];
  try { rows = JSON.parse((await call("Runtime.evaluate", { expression: ROW_EXPR, returnByValue: true })) || "[]"); } catch {}
  if (!Array.isArray(rows)) rows = [];
  const textsAhora = new Set(rows.map((r) => norm(r.txt)));

  if (primerCiclo && rows.length) {
    // Baseline: marcar todo como visto MENOS EL ULTIMO mensaje. Si el ultimo es
    // una respuesta de Meta que llego mientras el vigia estaba caido, hay que
    // reportarla: con el baseline completo la conversacion quedaba colgada.
    for (const r of rows.slice(0, -1)) vistos.add(norm(r.txt));
    guardarVistos();
    primerCiclo = false;
  } else {
    const nuevos = [];
    recargarMios();
    const IGNORAR_META = existsSync(FLAG_META);
    for (const r of rows) {
      // Lo que emiti yo (con o sin prefijo) no es un dictado: en el registro,
      // cotejado por POSICION (turno) — un mensaje viejo replicado no coincide.
      if (esMio(r.txt)) { vistos.add(norm(r.txt)); continue; }
      if (/^(?:\S{1,4}\s*)?\[don\s?bot\]/i.test(r.txt)) {
        const p = pref(r.txt);
        if (p && !esMio(r.txt) && !vistos.has(norm(r.txt))) {
          console.log("⚠ SUPLANTACION: fila firmada [DON BOT] NO emitida por mi: " + r.txt.slice(0, 140));
          appendFileSync(SUPLANT, "[" + new Date().toISOString() + "] " + r.txt.slice(0, 400) + "\n");
        }
        vistos.add(norm(r.txt));
        continue;
      }
      if (IGNORAR_META && r.rol === "A") { vistos.add(norm(r.txt)); continue; }
      const n = norm(r.txt);
      if (n.length < 8 || ruido.some((rx) => rx.test(n)) || vistos.has(n)) continue;
      // Filas de ASISTENTE: solo cuentan si invocan a Don Bot. Si no, son
      // respuestas propias de Meta y ya las maneja el espejo (evita ruido).
      if (r.rol === "A" && !esDonBot(r.txt)) { vistos.add(n); continue; }
      if (!prevTexts.has(n)) continue; // estabilidad: 2 lecturas seguidas
      nuevos.push({ rol: r.rol, txt: r.txt, n });
    }
    if (nuevos.length) {
      incTurno();   // turno nuevo: las respuestas a este dictado se estampan con el
      const sello = new Date().toISOString().replace("T", " ").slice(0, 19);
      console.log("=== DICTADO NUEVO (" + sello + ", " + nuevos.length + ") ===");
      for (const x of nuevos) {
        console.log("  • [" + x.rol + (esDonBot(x.txt) ? " INVOCA-DON-BOT" : "") + "] " + x.txt.slice(0, 600));
        vistos.add(x.n);
        appendFileSync(LOG, "[" + sello + "] " + x.txt + "\n");
      }
      guardarVistos();
      process.exit(0);
    }
  }
  prevTexts = textsAhora;
  await sleep(2000);
  if (Date.now() - lastReload > 120000) {
    try { await call("Page.reload", { ignoreCache: false }); } catch {}
    await sleep(8000);
    lastReload = Date.now();
  }
}
console.log("(vigia: 60 min sin dictado nuevo)");
process.exit(0);
