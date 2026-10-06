// salud-meta.mjs — WATCHDOG autonomo.
// La pagina de Meta DEGRADA con el uso: pierde el composer y el input de
// archivos, y entonces las subidas fallan en silencio (y el broker recicla
// Chrome en loop). Este watcher la revisa cada 60s y, si esta degradada,
// reinicia el broker (Chrome fresco), reabre WhatsApp y reinicia el relay.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const LOG = join(BIN, "salud-meta.log");
const CDP = "http://127.0.0.1:9233";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; appendFileSync(LOG, l + "\n"); console.log(l); };
const sh = (cmd) => { try { execFileSync("bash", ["-lc", cmd], { stdio: "ignore", timeout: 180000 }); return true; } catch { return false; } };

async function salud() {
  const l = await (await fetch(CDP + "/json")).json();
  const t = l.find((x) => (x.url || "").includes("meta.ai/prompt/"));
  if (!t) return "sin-pestana";
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let i = 1; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); } };
  const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(() => r(undefined), 10000); });
  await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 4000); });
  const r = await call("Runtime.evaluate", { expression: `JSON.stringify({ files: document.querySelectorAll('input[type=file]').length, edit: document.querySelectorAll('[contenteditable=true]').length, body: (document.body.innerText||'').length })`, returnByValue: true });
  try { ws.close(); } catch {}
  if (!r) return "sin-respuesta";
  const d = JSON.parse(r);
  if (d.files === 0 && d.edit === 0) return "degradada";
  return "ok";
}

log("== salud-meta activo (chequeo cada 60s) ==");
for (let k = 0; k < 1440; k++) {
  try {
    const s = await salud();
    if (s === "degradada" || s === "sin-respuesta" || s === "sin-pestana") {
      log(`Meta ${s}: reinicio el broker (Chrome fresco) + reabro WhatsApp + relay`);
      sh("export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart meta-api.service");
      await sleep(8000);
      sh("curl -s --max-time 90 http://127.0.0.1:8055/warmup >/dev/null 2>&1"); await sleep(14);
      sh('curl -s -X PUT "http://127.0.0.1:9233/json/new?$(python3 -c \\"import urllib.parse;print(urllib.parse.quote(\'https://web.whatsapp.com\'))\\")" >/dev/null 2>&1'); await sleep(18);
      sh("export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart wsp.service");
      await sleep(20);
      log("recuperacion completa");
    } else if (k % 10 === 0) log("Meta ok");
  } catch (e) { log("error en el chequeo: " + String(e).slice(0, 80)); }
  await sleep(60000);
}
