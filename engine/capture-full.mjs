// capture-full.mjs — captura de diagnostico: un mensaje CON imagen y otro de
// texto en el MISMO chat, con TODAS las cabeceras (upload incluido).
//
//   node engine/capture-full.mjs [puertoCDP] [imagen]
//
// Salida: /tmp/opencode/full-<ts>.json (token REDACTED).

import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 9298);
const IMG = process.argv[3] ?? "/tmp/opencode/test-image.png";
const OUT = `/tmp/opencode/full-${Date.now()}.json`;

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let page = tabs.find((t) => t.type === "page" && /meta\.ai/.test(t.url));
if (!page) {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/new?https://www.meta.ai/`, { method: "PUT" });
	page = await res.json();
}
console.error("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 1;
const pending = new Map();
const cap = { sockets: [], frames: [], requests: [], responses: [] };

ws.onmessage = async (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.webSocketCreated":
			cap.sockets.push({ id: p.requestId, url: p.url });
			break;
		case "Network.webSocketFrameSent":
			cap.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 80000) });
			break;
		case "Network.webSocketFrameReceived":
			cap.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 80000) });
			break;
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/rupload|meta\.ai/.test(u)) {
				cap.requests.push({
					url: u, method: p.request.method, ts: Date.now(),
					headers: p.request.headers ?? {},
					postData: (p.request.postData ?? "").slice(0, 1500),
				});
			}
			break;
		}
		case "Network.responseReceived": {
			const u = p.response?.url ?? "";
			if (/rupload/.test(u)) {
				cap.responses.push({ url: u, status: p.response.status, headers: p.response.headers ?? {}, ts: Date.now() });
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

async function enviar(text, { imagen = false } = {}) {
	if (imagen) {
		const doc = await call("DOM.getDocument", { depth: -1 });
		const { nodeIds } = await call("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
		for (const nodeId of nodeIds) {
			try { await call("DOM.setFileInputFiles", { nodeId, files: [IMG] }); } catch { /* input no listo */ }
		}
		await sleep(3500);
	}
	let rct = null;
	for (let i = 0; i < 25; i++) {
		rct = await ev2(composerSel);
		if (rct) break;
		await sleep(1200);
	}
	if (!rct) throw new Error("composer no aparecio");
	const x = Math.round(rct.x + rct.w / 2), y = Math.round(rct.y + rct.h / 2);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	await sleep(700);
	await call("Input.insertText", { text });
	await sleep(900);
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	console.error("enviado:", text.slice(0, 50), imagen ? "(con imagen)" : "");
}

await enviar("El color de marca de mi proyecto es verde azulado. Que color ves en la imagen adjunta?", { imagen: true });
await sleep(45000);
await enviar("Recuerdas cual era el color de marca? Una palabra.");

const clean = {
	capturedAt: new Date().toISOString(),
	sockets: cap.sockets.map((s) => ({ ...s, url: s.url.replace(/(Authorization=)ecto1%3A[^&]*/i, "$1ecto1%3AREDACTED") })),
	frames: cap.frames,
	requests: cap.requests,
	responses: cap.responses,
};
fs.writeFileSync(OUT, JSON.stringify(clean, null, 1));
console.error("captura:", OUT, "| requests", cap.requests.length, "| frames", cap.frames.length);
process.exit(0);
