// capture-ws.mjs — captura WS frames + requests durante un envio autenticado.
// Se engancha al chrome visible en 9298, manda el prompt como humano (click+insert+Enviar)
// y graba: todos los POST a api/graphql, sockets de meta.ai y frames sent/received.

import { writeFileSync } from "node:fs";

const PORT = 9298;
const OUT = "/tmp/opencode/capture-ws.json";
const PROMPT = "responde solo: hola";

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = tabs.find((t) => t.type === "page" && /^https?:/.test(t.url)) ?? tabs.find((t) => t.type === "page");
if (!page) { console.error("sin page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 1;
const pending = new Map();
const log = { requests: [], sockets: [], frames: [] };
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			const rr = p.request;
			if (/meta\.ai/.test(u) && !/_next\/static|woff|analytics/.test(u)) {
				log.requests.push({ url: u, method: rr.method, headers: rr.headers, postData: rr.postData?.slice(0, 6000) ?? null });
			}
			break;
		}
		case "Network.responseReceived": {
			const u = p.response?.url ?? "";
			for (const rr of log.requests) if (rr.url === u && rr.status === undefined) rr.status = p.response.status;
			break;
		}
		case "Network.webSocketCreated":
			log.sockets.push({ id: p.requestId, url: p.url, ts: Date.now() });
			break;
		case "Network.webSocketFrameSent":
			log.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 8000) });
			break;
		case "Network.webSocketFrameReceived":
			log.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 8000) });
			break;
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r?.result?.value);

await call("Network.enable");
await call("Page.enable");

// click en el composer: atraviesa shadow roots (el composer nuevo vive dentro de uno)
const sel = `(function () {
	const out = [];
	const walk = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) walk(el.shadowRoot);
			if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || (el.getAttribute && el.getAttribute("contenteditable") === "true")) {
				const rr = el.getBoundingClientRect();
				if (rr.width > 60 && rr.height > 8) out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName });
			}
		}
	};
	walk(document);
	return out[0] ?? null;
})()`;
await call("Page.navigate", { url: "https://www.meta.ai/" });
await new Promise((r) => setTimeout(r, 15000));
let rct = null;
waitLoop: for (let i = 0; i < 20; ++i) {
	const n = await ev2(sel);
	if (n) { rct = n; break waitLoop; }
	await new Promise((r) => setTimeout(r, 1500));
}
if (!rct) { console.error("composer no aparecio tras 30s"); process.exit(1); }
console.error(`composer: tag=${rct.tag} en ${Math.round(rct.x)},${Math.round(rct.y)} ${Math.round(rct.w)}x${Math.round(rct.h)}`);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rct.x + rct.w / 2), y: Math.round(rct.y + rct.h / 2), button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(rct.x + rct.w / 2), y: Math.round(rct.y + rct.h / 2), button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 700));
await call("Input.insertText", { text: PROMPT });
await new Promise((r) => setTimeout(r, 1000));
console.error("activo tras insert:", await ev2(`JSON.stringify({ tag: document.activeElement.tagName, val: (document.activeElement.value ?? document.activeElement.textContent ?? '').slice(0, 50) })`));
await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

await new Promise((r) => setTimeout(r, 45000));

// en streaming no se puede leer el body con getResponseBody: nos quedamos con frames
ws.close();
writeFileSync(OUT, JSON.stringify(log, null, 1));
console.error(`requests: ${log.requests.length} | sockets: ${log.sockets.length} | frames: ${log.frames.length}`);
const s = log.sockets.map((x) => x.url);
console.error("sockets:", s.join("\n  "));
process.exit(0);
