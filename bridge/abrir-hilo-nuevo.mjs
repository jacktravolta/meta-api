// abrir-hilo-nuevo.mjs — OPCION C: crea un HILO NUEVO de transcripcion.
// Va a la home de Meta, escribe el mensaje de arranque en el composer y lo envia.
// Al enviar, Meta crea el hilo y la URL pasa a /prompt/<nuevo-id>.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CDP = "http://127.0.0.1:9233";
const ARRANQUE = "Transcribir audio o video. Modo transcripcion: solo transcribis lo que hablo. El agente (Don Bot) actua solo cuando menciono 'Don Bot'.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const l = await (await fetch(CDP + "/json")).json();
let t = l.find((x) => x.type === "page" && (x.url || "").includes("meta.ai"));
if (!t) { console.log("no hay pestaña de Meta"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value ?? m.error); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 20000); });
const ev = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

console.log("navegando a la home de Meta...");
await call("Page.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
await sleep(16000);
console.log("url:", await ev("location.href"));

// Escribir en el composer de la home y enviar.
const c = await ev(`(() => { const el = document.querySelector('[data-testid="composer-input"][contenteditable="true"]'); if (!el) return 'no-composer'; el.focus(); return 'ok'; })()`);
console.log("composer:", c);
if (c !== "ok") { console.log("no encontre el composer en la home"); process.exit(1); }
await sleep(700);
await call("Input.insertText", { text: ARRANQUE });
await sleep(1500);
let enviado = false;
for (let k = 0; k < 5 && !enviado; k++) {
  const r = await ev(`(() => { const b = document.querySelector('[data-testid="composer-send-button"]'); if (b && !b.disabled) { b.click(); return 'click'; } return 'disabled'; })()`);
  await sleep(3000);
  const txt = await ev(`(() => { const el = document.querySelector('[data-testid="composer-input"][contenteditable="true"]'); return (el?.innerText || '').trim(); })()`);
  if (!txt) { enviado = true; break; }
  console.log("intento " + (k + 1) + ": " + r + " (composer con texto)");
}
console.log(enviado ? "MENSAJE DE ARRANQUE ENVIADO ✓" : "no se pudo enviar");
await sleep(12000);
const url = await ev("location.href");
const id = String(url || "").match(/\/prompt\/([a-f0-9-]{8,})/);
console.log("url final: " + url);
if (id) {
  writeFileSync(join(BIN, "hilo-nuevo.json"), JSON.stringify({ id: id[1], url, ts: new Date().toISOString() }, null, 1));
  console.log("ID DEL HILO NUEVO: " + id[1]);
} else console.log("no detecte id de hilo nuevo");
process.exit(0);
