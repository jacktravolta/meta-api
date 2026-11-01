// screenshot-juego.mjs — captura la pestana del juego (CDP, Chrome visible)
//   node engine/screenshot-juego.mjs [salida.png]
import fs from "node:fs";

const OUT = process.argv[2] || "/tmp/opencode/juego.png";
const tabs = await (await fetch("http://127.0.0.1:9298/json")).json();
const game = tabs.find((t) => t.type === "page" && /127\.0\.0\.1:8123/.test(t.url));
if (!game) { console.error("no hay pestana del juego (127.0.0.1:8123)"); process.exit(2); }

const ws = new WebSocket(game.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const estado = await send("Runtime.evaluate", {
	expression: `(() => ({
		titulo: document.title,
		canvas: document.querySelectorAll('canvas').length,
		texto: (document.body?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 200),
	}))()`, returnByValue: true,
});
console.log("estado:", JSON.stringify(estado.result?.value));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (!shot?.data) { console.error("no se pudo capturar"); process.exit(1); }
fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("captura:", OUT, fs.statSync(OUT).size, "bytes");
ws.close();
process.exit(0);
