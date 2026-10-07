// diag-audio-vivo.mjs — observador en vivo del trafico mientras llega una
// nota de voz. NO modifica nada: solo escucha y anota en diag-audio-vivo.log.
//
// Por que existe: relay/wsp.mjs probó capturar el audio por Network y llega
// siempre con 0 eventos. Antes de inventar otra via hay que ver QUÉ hace
// WhatsApp de verdad cuando recibe y reproduce una nota de voz: si la baja
// por HTTP, si la trae por el WebSocket, o si la sirve un Service Worker
// (los eventos de la pagina no alcanzan a ver todo eso igual).
//
// Uso:  node bridge/diag-audio-vivo.mjs [segundos]   (default: correr hasta Ctrl-C)
// Luego mandar una nota de voz en el chat y leer el log.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = dirname(fileURLToPath(import.meta.url));
const LOG = join(BIN, "..", "relay", "state", "diag-audio-vivo.log");
const CDP = process.env.DIAG_CDP || "http://127.0.0.1:9233";
const SEGUNDOS = Number(process.argv[2] || 0);

if (!existsSync(LOG)) writeFileSync(LOG, "");
const log = (tipo, detalle) => {
  const l = `[${new Date().toISOString()}] ${tipo.padEnd(26)} ${detalle}`;
  appendFileSync(LOG, l + "\n");
  console.log(l);
};

const lista = await (await fetch(`${CDP}/json`)).json();
const t = lista.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.error("no hay pestana de WhatsApp en " + CDP); process.exit(1); }

log("conexion", `pestaña=${t.title.slice(0, 30)} url=${t.url.slice(0, 55)}`);

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const vistos = new Set();

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  const p = m.params || {};
  switch (m.method) {
    case "Network.requestWillBeSent":
      log("REQ", `${p.request?.method || "?"} ${String(p.request?.url || "").slice(0, 110)}`);
      break;
    case "Network.responseReceived": {
      const r = p.response || {};
      log("RES", `mt=${r.mimeType || "?"} status=${r.status} sw=${!!p.fromServiceWorker} cache=${!!p.fromPrefetchCache} ${String(r.url || "").slice(0, 90)}`);
      break;
    }
    case "Network.loadingFinished":
      log("FIN", `requestId=${p.requestId} bytes=${p.encodedDataLength}`);
      break;
    case "Network.loadingFailed":
      log("FAIL", `${p.errorText || "?"} canceled=${!!p.canceled} id=${p.requestId}`);
      break;
    case "Network.dataReceived":
      if (p.dataLength > 0) log("DATA", `bytes=${p.dataLength} id=${p.requestId}`);
      break;
    case "Network.webSocketCreated":
      log("WS-OPEN", String(p.url || "").slice(0, 100));
      break;
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      const dir = m.method === "Network.webSocketFrameSent" ? "TX" : "RX";
      const pay = p.response?.payloadData;
      const n = typeof pay === "string" ? pay.length : (p.response?.opcode ?? "?");
      log(`WS-${dir}`, `op=${p.response?.opcode ?? "?"} len=${n}`);
      break;
    }
    case "Network.webSocketClosed":
      log("WS-CLOSE", String(p.url || "").slice(0, 80));
      break;
  }
};

const call = (method, params) => new Promise((r) => {
  const i = id++;
  pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => r({ error: { message: "timeout" } }), 8000);
});

await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });

// Se habilita igual que el relay y ademas se desactiva la cache, para no
// confundir "no hubo peticion" con "estaba en cache".
log("setup", "Network.enable + setCacheDisabled");
const en = await call("Network.enable", {});
log("setup", en?.error ? `Network.enable ERROR ${en.error.message}` : "Network.enable ok");
await call("Network.setCacheDisabled", { cacheDisabled: true });

// Sondeo del DOM: si aparece una nota de voz, anotar su estructura.
const SONDEO = `(() => {
  const rows = [...document.querySelectorAll('[role=row]')].filter(r => r.querySelector('[data-id]'));
  const con = rows.filter(r => r.querySelector('[aria-label*="eproducir"], [aria-label*="udio"], [data-testid*="audio"]'));
  const auds = [...document.querySelectorAll('audio')];
  const cache = (typeof caches !== 'undefined');
  return JSON.stringify({
    filas: rows.length, filasVoz: con.length, audioEls: auds.length,
    audioSrc: auds.slice(0, 2).map(a => ({ src: (a.src || '').slice(0, 60), rs: a.readyState, dur: a.duration })),
    último: con.slice(-1).map(r => ({ id: (r.querySelector('[data-id]')?.getAttribute('data-id') || '').slice(0, 40), txt: (r.innerText || '').replace(/\\n/g, ' | ').slice(0, 60) }))[0] || null
  });
})()`;

let n = 0;
const sondeo = setInterval(async () => {
  n++;
  const r = await call("Runtime.evaluate", { expression: SONDEO, returnByValue: true });
  const v = r?.result?.result?.value;
  if (v) {
    const j = JSON.parse(v);
    if (j.filasVoz > 0 || j.audioEls > 0 || n % 6 === 0) log("DOM", v);
  }
}, 3000);

log("inicio", SEGUNDOS ? `observando ${SEGUNDOS}s` : "observando (Ctrl-C para cortar)");

if (SEGUNDOS) {
  setTimeout(() => { clearInterval(sondeo); log("fin", "tiempo cumplido"); process.exit(0); }, SEGUNDOS * 1000);
}
