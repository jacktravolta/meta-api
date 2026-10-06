// escuchar-errores-meta.mjs — DIAGNOSTICO: escucha permanentemente la consola de
// la pagina de Meta y registra cualquier error/excepcion en un archivo, para
// identificar el problema REAL cuando el SPA se rompe (body vacio).
// Si es OOM vera "Out of memory"; si es React, "Minified React error #...".
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const LOG = join(BIN, "meta-errores.log");
const canal = existsSync(join(BIN, "canal.json")) ? JSON.parse(readFileSync(join(BIN, "canal.json"), "utf8")) : null;
const CDP = "http://127.0.0.1:9233";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const linea = (s) => { const l = `[${new Date().toISOString()}] ${s}`; appendFileSync(LOG, l + "\n"); console.log(l); };

async function conectar() {
  const l = await (await fetch(CDP + "/json")).json();
  const t = l.find((x) => (x.url || "").includes(canal && canal.id ? canal.id : "meta.ai"));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
  let i = 1; const p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); return; }
    if (m.method === "Log.entryAdded") {
      const en = m.params.entry;
      if (en.level === "error") linea(`[error] ${String(en.text).slice(0, 300)} | url=${String(en.url || "").slice(0, 160)} | source=${en.source || ""}`);
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      linea(`EXCEPCION: ${String(d.exception?.description || d.text || "").slice(0, 500)} | url=${String(d.url || "").slice(0, 160)}`);
    }
  };
  const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 10000); });
  await call("Log.enable", {});
  await call("Runtime.enable", {});
  return { ws, call };
}

linea("== escucha de errores de Meta activa ==");
for (let k = 0; k < 100000; k++) {
  let c = null;
  try { c = await conectar(); } catch {}
  if (!c) { await sleep(15000); continue; }
  linea("conectado a la consola del hilo");
  // Mantener la conexion viva; si se cae, reconectar.
  const t0 = Date.now();
  while (c.ws.readyState === 1 && Date.now() - t0 < 600000) await sleep(5000);
  try { c.ws.close(); } catch {}
  linea("conexion caida: reconectando");
  await sleep(5000);
}
