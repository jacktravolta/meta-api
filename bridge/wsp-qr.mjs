// wsp-qr.mjs — captura el QR de WhatsApp Web y lo guarda como PNG.
import { writeFileSync } from "node:fs";
const CDP = "http://127.0.0.1:9233";
const OUT = process.argv[2] || "/home/test/test/meta-api/bridge/wsp-qr.png";
const lista = await (await fetch(CDP + "/json")).json();
const t = lista.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no hay pestaña de WhatsApp"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const call = (method, params) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
await call("Page.enable");
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot && shot.data) { writeFileSync(OUT, Buffer.from(shot.data, "base64")); console.log("PNG guardado: " + OUT); }
else console.log("no se pudo capturar");
process.exit(0);
