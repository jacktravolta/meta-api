// enviar-hilo.mjs — publica texto en el canal como el usuario, con firma [DON BOT].
// Uso: node enviar-hilo.mjs /ruta/al/texto.txt
import { readFileSync, existsSync, appendFileSync } from "node:fs";
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
const FRAG = (canal && canal.id) || "";

let TEXTO = readFileSync(process.argv[2], "utf8").trim();
// REGLA: mensajes del agente en WhatsApp/hilo van SIEMPRE con [DON BOT].
// Excepcion: los mensajes PARA META no llevan prefijo (SIN_PREFIJO=1), porque
// contamina sus respuestas (regla de Don Jack).
if (!process.env.SIN_PREFIJO && !/^(\S{1,4}\s*)?\[don\s?bot\]/i.test(TEXTO)) TEXTO = "∞ [DON BOT] " + TEXTO;

const list = await (await fetch("http://127.0.0.1:9233/json")).json();
let target = list.find((t) => t.type === "page" && (t.url || "").includes(FRAG));
if (!target) target = await (await fetch("http://127.0.0.1:9233/json/new?" + encodeURIComponent("https://www.meta.ai/prompt/" + FRAG), { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const send = (m, p, id) => ws.send(JSON.stringify({ id, method: m, params: p }));
let seq = 1; const pending = new Map();
const call = (m, p) => { const id = seq++; return new Promise((r) => { pending.set(id, r); send(m, p, id); setTimeout(() => r(undefined), 15000); }); };
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result?.result?.value ?? d.error); pending.delete(d.id); } };
const ev = (e) => call("Runtime.evaluate", { expression: e, returnByValue: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

// ── HOMOLOGADO cdpAutoCura: Resolutor como capa de respaldo (solo fallback) ──
const teleHilo = new Telemetria("donbot-enviar-hilo", join(BIN, "telemetria-enviar-hilo.jsonl"));
let resolHilo = null; // se crea lazy cuando se necesita
const MAPA_DONBOT_URL = process.env.MAPA_DONBOT_URL || "http://127.0.0.1:8799/donbot-selectors.json";
const SPEC_COMPOSER_HILO = {
  sel: "div[data-testid='composer-input'][contenteditable='true'], textarea, [contenteditable='true']",
  rx: /composer|escribir|message/i,
  anclas: [
    "div[data-testid='composer-input'][contenteditable='true']",
    "div[data-testid='composer-input'][contenteditable='plaintext-only']",
    "textarea",
  ],
  masGrande: true,
};

let c = await ev(`(() => { const el = document.querySelector('[data-testid="composer-input"][contenteditable="true"]'); if (!el) return 'no-composer'; el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok'; })()`);
// HOMOLOGADO cdpAutoCura: si el selector principal falló, el Resolutor intenta
// resolver el composer por anclas. NO destructivo.
if (c === 'no-composer') {
  if (!resolHilo) resolHilo = new Resolutor(call, { app: "donbot-enviar-hilo", version: "1", mapaUrl: MAPA_DONBOT_URL, telemetria: teleHilo });
  const r = await resolHilo.resolver("composer-meta", SPEC_COMPOSER_HILO);
  if (r) {
    c = await ev(`(() => { const el = document.querySelector(${JSON.stringify(r.selector)}); if (!el) return 'no-composer'; el.focus(); const rc = document.createRange(); rc.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(rc); return 'ok'; })()`);
    if (c === 'ok') console.log(`composer resuelto por el Resolutor (via: ${r.via})`);
  }
}
console.log("composer:", c);
await sleep(400);
await call("Input.insertText", { text: TEXTO });
await sleep(1500);
const composerTxt = async () => (await ev(`(() => { const el = document.querySelector('[data-testid="composer-input"][contenteditable="true"]'); return (el?.innerText || '').trim(); })()`)) || "";
let enviado = false;
for (let intento = 0; intento < 4 && !enviado; intento++) {
  await ev(`(() => { const b = document.querySelector('[data-testid="composer-send-button"]'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
  await sleep(2500);
  if (!(await composerTxt())) { enviado = true; break; }
  const btn = await ev(`(() => { const b = document.querySelector('[data-testid="composer-send-button"]'); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
  if (btn) {
    const p = JSON.parse(btn);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(2500);
    if (!(await composerTxt())) enviado = true;
  }
}
console.log(enviado ? "ENVIADO ✓ (composer vacio)" : "NO SE PUDO ENVIAR (texto aun en el composer)");
if (enviado) {
  try {
    // Registro con TURNO (turno|texto): el detector coteja por POSICION.
    let turno = 0;
    try { turno = JSON.parse(readFileSync(join(BIN, "turno.json"), "utf8")).n || 0; } catch {}
    appendFileSync(ENVIADOS, turno + "|" + TEXTO.replace(/^\[DON BOT\]\s*/i, "") + "\n");
  } catch {}
}
process.exit(enviado ? 0 : 1);
