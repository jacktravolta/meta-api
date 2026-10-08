// leer-ultima.mjs — ultimo mensaje del hilo (cualquier rol), completo.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// HOMOLOGADO cdpAutoCura: el Resolutor es SOLO un fallback. El selector principal
// se evalúa primero; el Resolutor entra únicamente cuando el principal devuelve null.
import { Resolutor, Telemetria } from "./lib/resolver.mjs";
const BIN = dirname(fileURLToPath(import.meta.url));
const canal = existsSync(join(BIN, "canal.json")) ? JSON.parse(readFileSync(join(BIN, "canal.json"), "utf8")) : null;
if (!canal) { console.log("sin canal.json"); process.exit(2); }
const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes(canal.id));
if (!t) { console.log("no hay pestaña del canal"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

// ── HOMOLOGADO cdpAutoCura: Resolutor como capa de respaldo (solo fallback) ──
const teleLeerUltima = new Telemetria("donbot-leer-ultima", join(BIN, "telemetria-leer-ultima.jsonl"));
let resolLeerUltima = null;
const MAPA_DONBOT_URL = process.env.MAPA_DONBOT_URL || "http://127.0.0.1:8799/donbot-selectors.json";
const SPEC_FILAS_META_ULTIMA = {
  sel: "[class*='group/message-row'], [data-testid='message-row'], [role='row']",
  rx: /message|mensaje/i,
  anclas: ["[class*='group/message-row']", "[data-testid='message-row']", "[role='row']"],
  masGrande: false,
};

let r = await call("Runtime.evaluate", { expression: `(() => {
  const rs = [...document.querySelectorAll('[class*="group/message-row"]')];
  const l = rs[rs.length-1];
  if (!l) return '(sin filas)';
  const rol = l.querySelector('[data-testid="assistant-message"]') ? 'META' : 'USUARIO';
  return '[' + rol + ']\\n' + (l.innerText || '').trim();
})()`, returnByValue: true });
// HOMOLOGADO cdpAutoCura: si el selector principal no encontró filas, el Resolutor
// intenta resolverlas por anclas. NO destructivo.
if (!r?.result?.value || r.result.value === '(sin filas)') {
  if (!resolLeerUltima) resolLeerUltima = new Resolutor(call, { app: "donbot-leer-ultima", version: "1", mapaUrl: MAPA_DONBOT_URL, telemetria: teleLeerUltima });
  const rp = await resolLeerUltima.resolver("fila-mensaje-meta", SPEC_FILAS_META_ULTIMA);
  if (rp) {
    r = await call("Runtime.evaluate", { expression: `(() => {
      const rs = [...document.querySelectorAll(${JSON.stringify(rp.selector)})];
      const l = rs[rs.length-1];
      if (!l) return '(sin filas)';
      const rol = l.querySelector('[data-testid="assistant-message"]') ? 'META' : 'USUARIO';
      return '[' + rol + ']\\n' + (l.innerText || '').trim();
    })()`, returnByValue: true });
    if (r?.result?.value && r.result.value !== '(sin filas)') console.log(`fila resuelta por el Resolutor (via: ${rp.via})`);
  }
}
console.log(r?.result?.value || "sin dato");
process.exit(0);
