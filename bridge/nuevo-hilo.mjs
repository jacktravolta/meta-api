// nuevo-hilo.mjs — abre un HILO NUEVO en Meta (opcion C) y devuelve su id/URL.
// Clickea "Nuevo chat" en el sidebar y espera la navegacion.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const CDP = "http://127.0.0.1:9233";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const l = await (await fetch(CDP + "/json")).json();
const t = l.find((x) => (x.type === "page" && (x.url || "").includes("meta.ai")));
if (!t) { console.log("no hay pestaña de Meta"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 15000); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });

const antes = await q("location.href");
console.log("url antes: " + antes);

// Buscar el boton "Nuevo chat" (por texto o testid) y clickearlo (DOM click).
const click = await q(`(() => {
  const cands = [...document.querySelectorAll('a, button, [role=button]')];
  const b = cands.find(e => /nuevo chat|new chat/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
  if (!b) return 'no encontre Nuevo chat';
  b.click();
  return 'clickeado';
})()`);
console.log("click: " + click);
await sleep(8000);
const despues = await q("location.href");
const titulo = await q("document.title");
console.log("url despues: " + despues);
console.log("title: " + titulo);
const id = String(despues || "").match(/\/prompt\/([a-f0-9-]{8,})/);
if (id) {
  writeFileSync(join(BIN, "hilo-nuevo.json"), JSON.stringify({ id: id[1], url: despues, ts: new Date().toISOString() }, null, 1));
  console.log("ID DEL HILO NUEVO: " + id[1]);
} else console.log("no detecte un id de hilo nuevo");
process.exit(0);
