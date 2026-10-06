// canal.mjs — descubre el CANAL valido: el chat MAS RECIENTE cuyo titulo mencione
// transcripcion ("Transcribir audio o video", "transcriptor", etc.).
// Escribe canal.json {id,url,title,index,ts,bootstrapped} para vigia y enviar-hilo.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CANAL = join(BIN, "canal.json");
const RX = /transcri|audio\s*o\s*video/i;
const CDP = "http://127.0.0.1:9233";

const prev = existsSync(CANAL) ? JSON.parse(readFileSync(CANAL, "utf8")) : null;

const list = await (await fetch(CDP + "/json")).json();
const tabs = list.filter((t) => t.type === "page" && /meta\.ai\/prompt\//.test(t.url || ""));
let target = tabs[0];
if (!target) {
  target = await (await fetch(CDP + "/json/new?" + encodeURIComponent("https://www.meta.ai/"), { method: "PUT" })).json();
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
const send = (m, p, id) => ws.send(JSON.stringify({ id, method: m, params: p }));
let seq = 1; const pending = new Map();
const call = (m, p) => { const id = seq++; return new Promise((r) => { pending.set(id, r); send(m, p, id); setTimeout(() => r(undefined), 12000); }); };
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result?.result?.value ?? d.error); pending.delete(d.id); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

const leer = async () => JSON.parse((await call("Runtime.evaluate", {
  expression: `JSON.stringify([...document.querySelectorAll('a[href*="/prompt/"]')].map((a, i) => ({ i, href: a.getAttribute('href'), txt: (a.innerText || '').replace(/\\n+/g, ' ').trim() })))`,
  returnByValue: true,
})) || "[]");

let links = await leer();
if (!links.length) {
  await call("Runtime.evaluate", { expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => /barra lateral|lateral|sidebar/i.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return !!b; })()`, returnByValue: true });
  await sleep(4500);
  links = await leer();
}
const canales = links.filter((l) => RX.test(l.txt));
if (!canales.length) { console.log("NO se encontro ningun chat de transcripcion"); process.exit(2); }
const pick = canales[0]; // el listado va del mas reciente al mas viejo
const id = pick.href.replace(/^\/prompt\//, "");

// CHANNEL BINDING POR CONFIG (diseno de Meta): un canal nuevo NO se adopta solo.
// Si ya hay un canal fijado y aparece otro, se avisa y NO se cambia salvo que se
// pase --cambiar explicitamente (accion deliberada, no un mensaje del chat).
if (prev && prev.id && prev.id !== id && !process.argv.includes("--cambiar")) {
  console.log("⚠ CANAL NUEVO DETECTADO: " + pick.txt + " (" + id.slice(0, 8) + ")");
  console.log("  Canal FIJADO actual: " + prev.title + " (" + prev.id.slice(0, 8) + ")");
  console.log("  NO se cambia (binding por config). Para moverlo a proposito:");
  console.log("     node canal.mjs --cambiar");
  process.exit(0);
}
if (prev && prev.id && prev.id !== id) console.log("  --cambiar: moviendo el canal fijado...");

const out = { id, url: "https://www.meta.ai/prompt/" + id, title: pick.txt, index: pick.i, ts: new Date().toISOString(), bootstrapped: prev && prev.id === id ? !!prev.bootstrapped : false };
writeFileSync(CANAL, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
process.exit(0);
