// capturar-ultima-nota.mjs — reproduce la ultima nota de voz del chat, se queda
// con su audio y lo deja en disco listo para transcribir.
//
// Por que hace falta setCacheDisabled: verificado con diag-audio-vivo.mjs, el
// click en play solo dispara Network.responseReceived (mt=audio/ogg, status=206,
// url blob:) cuando la cache del navegador esta apagada. Con cache encendida el
// media se sirve sin peticion y el buffer queda en cero — ese era el "buffer
// vacio" del relay. setCacheDisabled es POR TARGET, asi que afecta a todas las
// sesiones de la pestaña.
//
// Uso:  node bridge/capturar-ultima-nota.mjs   -> imprime la ruta del .ogg
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(BIN, "..", "relay", "state", "media");
const CDP = process.env.DIAG_CDP || "http://127.0.0.1:9233";
const paso = (s) => console.error(`[${new Date().toISOString()}] ${s}`);

paso("buscando pestaña");
const lista = await (await fetch(`${CDP}/json`)).json();
const t = lista.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.error("no hay pestana de WhatsApp"); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const audios = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Network.responseReceived") {
    const mt = m.params?.response?.mimeType || "";
    if (/^audio\//i.test(mt)) audios.push({ requestId: m.params.requestId, mt, url: m.params.response.url });
  }
};
const call = (method, params) => new Promise((r) => {
  const i = id++;
  pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => r({ error: { message: "timeout" } }), 15000);
});
const ev = async (expression, awaitPromise) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: !!awaitPromise });
  return r?.result?.result?.value;
};

await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
paso("ws abierto");

// Cache apagada: sin esto no hay petición que observar.
paso("Network.enable");
paso(" -> " + JSON.stringify((await call("Network.enable", {}))?.error || "ok"));
paso("setCacheDisabled");
paso(" -> " + JSON.stringify((await call("Network.setCacheDisabled", { cacheDisabled: true }))?.error || "ok"));

// Ultima nota de voz visible.
const fila = await ev(`(() => {
  const rows = [...document.querySelectorAll('[role=row]')].filter(r => r.querySelector('[data-id]'));
  const voz = rows.filter(r => r.querySelector('[aria-label*="eproducir"], [aria-label*="udio"], [data-testid*="audio"]'));
  if (!voz.length) return null;
  const f = voz[voz.length - 1];
  const b = f.querySelector('[aria-label*="eproducir"], [aria-label*="udio"], [data-testid*="audio"]');
  if (!b) return null;
  const id = f.querySelector('[data-id]').getAttribute('data-id');
  b.scrollIntoView({ block: 'center' });
  b.click();
  return JSON.stringify({ dataId: id, txt: (f.innerText || '').replace(/\\n/g, ' | ').slice(0, 70) });
})()`);

if (!fila) { console.error("no hay notas de voz en el chat"); process.exit(2); }
const meta = JSON.parse(fila);
paso(`click hecho — ${meta.dataId} | ${meta.txt}`);

// Espera a que llegue el audio.
let got = null;
for (let i = 0; i < 25 && !got; i++) {
  await new Promise((r) => setTimeout(r, 500));
  got = audios[0] || null;
}
if (!got) { console.error("sin respuesta audio/* tras 12.5 s (audio=" + audios.length + ")"); process.exit(3); }
console.log("respuesta:", got.mt, got.url.slice(0, 60));

// Cuerpo: primero por CDP; si no, fetch del blob dentro de la pagina.
let b64 = null;
const r = await call("Network.getResponseBody", { requestId: got.requestId });
if (r?.result?.body) {
  b64 = r.result.base64Encoded ? r.result.body : Buffer.from(r.result.body, "binary").toString("base64");
  console.log("cuerpo por CDP:", Math.round(b64.length * 0.75), "bytes");
} else {
  console.log("CDP no dio cuerpo:", JSON.stringify(r?.error || r?.result || {}).slice(0, 90));
  b64 = await ev(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(got.url)});
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    } catch (e) { return 'ERR ' + e.message; }
  })()`, true);
  if (b64 && b64.startsWith("ERR")) { console.error("fetch en pagina:", b64); process.exit(4); }
  console.log("cuerpo por fetch en pagina:", Math.round((b64?.length || 0) * 0.75), "bytes");
}

if (!b64 || b64.length < 200) { console.error("cuerpo vacio"); process.exit(5); }

const ruta = join(MEDIA, String(meta.dataId).replace(/[^A-Za-z0-9._-]/g, "_") + ".ogg");
writeFileSync(ruta, Buffer.from(b64, "base64"));
console.log("GUARDADO " + ruta);
