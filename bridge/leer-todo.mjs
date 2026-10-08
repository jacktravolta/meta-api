// leer-todo.mjs — lector con scroll + VERIFICADOR DE AUTENTICIDAD.
//   * Scrollea el hilo para cargar mas filas (la lista esta virtualizada).
//   * Compara cada fila firmada [DON BOT] contra el registro real de envios:
//     las que no estan fueron firmadas por otro (suplantacion / otro agente).
// Uso: node leer-todo.mjs [maxPasosScroll]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// HOMOLOGADO cdpAutoCura: el Resolutor es SOLO un fallback. El selector principal
// se evalúa primero; el Resolutor entra únicamente cuando el principal devuelve null.
import { Resolutor, Telemetria } from "./lib/resolver.mjs";
const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const ENVIADOS = join(BIN, "don-bot-enviados.txt");
let canal = null;
try { canal = existsSync(CANAL) ? JSON.parse(readFileSync(CANAL, "utf8")) : null; } catch {}
if (!canal || !canal.id) { console.log("SIN CANAL: corre canal.mjs"); process.exit(2); }
const MAX = Number(process.argv[2] || 15);

const list = await (await fetch("http://127.0.0.1:9233/json")).json();
const target = list.find((t) => t.type === "page" && (t.url || "").includes(canal.id));
if (!target) { console.log("no tab"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const send = (m, p, id) => ws.send(JSON.stringify({ id, method: m, params: p }));
let seq = 1; const pending = new Map();
const call = (m, p) => { const id = seq++; return new Promise((r) => { pending.set(id, r); send(m, p, id); setTimeout(() => r(undefined), 10000); }); };
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result?.result?.value ?? d.error); pending.delete(d.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

// ── HOMOLOGADO cdpAutoCura: Resolutor como capa de respaldo (solo fallback) ──
const teleLeerTodo = new Telemetria("donbot-leer-todo", join(BIN, "telemetria-leer-todo.jsonl"));
let resolLeerTodo = null;
const MAPA_DONBOT_URL = process.env.MAPA_DONBOT_URL || "http://127.0.0.1:8799/donbot-selectors.json";
const SPEC_FILAS_META_LEER = {
  sel: "[class*='group/message-row'], [data-testid='message-row'], [role='row']",
  rx: /message|mensaje/i,
  anclas: ["[class*='group/message-row']", "[data-testid='message-row']", "[role='row']"],
  masGrande: false,
};

const leer = async () => {
  let rows = JSON.parse((await call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll('[class*="group/message-row"]')].map(r => (r.innerText||'').replace(/\\n+/g,' ').trim()).filter(Boolean))`, returnByValue: true })) || "[]");
  // HOMOLOGADO cdpAutoCura: si el selector principal no encontró filas, el Resolutor
  // intenta resolverlas por anclas. NO destructivo.
  if (!rows.length) {
    if (!resolLeerTodo) resolLeerTodo = new Resolutor(call, { app: "donbot-leer-todo", version: "1", mapaUrl: MAPA_DONBOT_URL, telemetria: teleLeerTodo });
    const r = await resolLeerTodo.resolver("fila-mensaje-meta", SPEC_FILAS_META_LEER);
    if (r) {
      const alt = JSON.parse((await call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll(${JSON.stringify(r.selector)})].map(x => (x.innerText||'').replace(/\\n+/g,' ').trim()).filter(Boolean))`, returnByValue: true })) || "[]");
      if (alt.length) { rows = alt; console.log(`filas resueltas por el Resolutor (via: ${r.via})`); }
    }
  }
  return rows;
};
const scrollUp = async () => await call("Runtime.evaluate", { expression: `(() => { const els=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+150); els.sort((a,b)=>b.scrollHeight-a.scrollHeight); const c=els[0]; if(!c) return 'no-scroller'; const antes=c.scrollTop; c.scrollTop=Math.max(0, c.scrollTop-c.clientHeight); return antes+'->'+c.scrollTop; })()`, returnByValue: true });

const vistas = new Map();
const agregar = (rows, paso) => { for (const t of rows) if (!vistas.has(t)) vistas.set(t, paso); };
agregar(await leer(), 0);
let paso = 0;
for (paso = 1; paso <= MAX; paso++) {
  const r = await scrollUp();
  await sleep(1500);
  const antes = vistas.size;
  agregar(await leer(), paso);
  if (String(r).includes("0->0") || vistas.size === antes) break;
}
const todas = [...vistas.keys()];
const donBot = todas.filter((t) => /^\[don\s?bot\]/i.test(t));
const norm = (t) => String(t || "").replace(/^\[?\s*don\s?bot\s*\]?\s*/i, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const pref = (t) => norm(t).slice(0, 50);
const mios = new Set((existsSync(ENVIADOS) ? readFileSync(ENVIADOS, "utf8").split("\n") : []).map(pref).filter(Boolean));
const reales = donBot.filter((t) => mios.has(pref(t)));
const falsos = donBot.filter((t) => !mios.has(pref(t)));
console.log("pasos de scroll:", paso);
console.log("filas distintas recolectadas:", todas.length);
console.log("filas con firma [DON BOT]:", donBot.length, "| VERIFICADAS mias:", reales.length, "| NO emitidas por mi:", falsos.length);
if (falsos.length) {
  console.log("  ⚠ FALSAS (firma [DON BOT] no emitida por el agente):");
  falsos.slice(0, 6).forEach((t) => console.log("     ⚠ " + t.slice(0, 110)));
}
process.exit(0);
