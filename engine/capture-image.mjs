// capture-image.mjs — mapea como viajan las IMAGENES/adjuntos en meta.ai:
//   1. el upload (endpoint + payload + respuesta) y
//   2. el slot del envelope protobuf donde queda la referencia.
//
//   node engine/capture-image.mjs [puertoCDP] [ruta-imagen]
//
// Requiere una imagen local. La salida: /tmp/opencode/image-<ts>.json con los
// requests (subidas) y los frames del WS (con token REDACTED).

import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 9298);
const IMG = process.argv[3] ?? "/tmp/opencode/test-image.png";
const OUT = `/tmp/opencode/image-${Date.now()}.json`;

if (!fs.existsSync(IMG)) {
	console.error("falta la imagen:", IMG);
	process.exit(2);
}

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let page = tabs.find((t) => t.type === "page" && /meta\.ai/.test(t.url));
if (!page) {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/new?https://www.meta.ai/`, { method: "PUT" });
	page = await res.json();
}
console.error("target:", page.url, "| imagen:", IMG);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 1;
const pending = new Map();
const cap = { sockets: [], frames: [], requests: [], responses: [] };
const bodyWaiters = new Map();

ws.onmessage = async (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.webSocketCreated":
			cap.sockets.push({ id: p.requestId, url: p.url });
			break;
		case "Network.webSocketFrameSent":
			cap.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 60000) });
			break;
		case "Network.webSocketFrameReceived":
			cap.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 60000) });
			break;
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/meta\.ai/.test(u)) {
				cap.requests.push({
					url: u, method: p.request.method, ts: Date.now(),
					contentType: p.request.headers?.["Content-Type"] ?? p.request.headers?.["content-type"] ?? null,
					postData: (p.request.postData ?? "").slice(0, 4000),
				});
				bodyWaiters.set(p.requestId, u);
			}
			break;
		}
		case "Network.loadingFinished": {
			const u = bodyWaiters.get(p.requestId);
			if (u) {
				try {
					const r = await call("Network.getResponseBody", { requestId: p.requestId });
					if (r?.body) cap.responses.push({ url: u, body: r.body.slice(0, 4000), ts: Date.now() });
				} catch { /* body no disponible */ }
			}
			break;
		}
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Network.enable");
await call("Page.enable");
await call("Runtime.enable");
await call("DOM.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
await sleep(16000);

// 1) adjuntar el archivo al input de archivo del front
const doc = await call("DOM.getDocument", { depth: -1 });
const { nodeIds } = await call("DOM.querySelectorAll", {
	nodeId: doc.root.nodeId,
	selector: 'input[type="file"]',
});
console.error("inputs de archivo:", nodeIds.length);
if (!nodeIds.length) {
	console.error("no hay input de archivo visible: el front lo crea al pulsar el clip");
}
for (const nodeId of nodeIds) {
	try {
		await call("DOM.setFileInputFiles", { nodeId, files: [IMG] });
		console.error("adjuntado en node", nodeId);
	} catch (err) {
		console.error("fallo al adjuntar:", err.message);
	}
}
await sleep(4000);

// 2) escribir el prompt y enviar
const composerSel = `(function () {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "TEXTAREA" || el.getAttribute?.("contenteditable") === "true") {
        const rr = el.getBoundingClientRect();
        if (rr.width > 60 && rr.height > 8) out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName });
      }
    }
  };
  walk(document);
  return out[0] ?? null;
})()`;
let rct = null;
for (let i = 0; i < 25; i++) {
	rct = await ev2(composerSel);
	if (rct) break;
	await sleep(1200);
}
if (!rct) { console.error("composer no aparecio"); process.exit(3); }
const x = Math.round(rct.x + rct.w / 2), y = Math.round(rct.y + rct.h / 2);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
await sleep(600);
await call("Input.insertText", { text: "Que ves en esta imagen? responde en una frase" });
await sleep(800);
await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
console.error("enviado con imagen");
await sleep(25000);

const clean = {
	capturedAt: new Date().toISOString(),
	image: IMG,
	sockets: cap.sockets.map((s) => ({ ...s, url: s.url.replace(/(Authorization=)ecto1%3A[^&]*/i, "$1ecto1%3AREDACTED") })),
	frames: cap.frames,
	requests: cap.requests,
	responses: cap.responses,
};
fs.writeFileSync(OUT, JSON.stringify(clean, null, 1));
console.error("captura:", OUT, "| requests", cap.requests.length, "| frames", cap.frames.length);
process.exit(0);
