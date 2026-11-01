// capture-pair.mjs — captura DOS mensajes consecutivos en el MISMO chat del
// navegador y guarda los envelopes de envio para diffearlos.
//
//   node engine/capture-pair.mjs [puertoCDP] "[mensaje 1]" "[mensaje 2]"
//
// Por que sirve: el gateway no reabre un hilo solo con el conversation_id.
// Hay algun campo del envelope que marca "turno nuevo dentro de un hilo
// existente". Comparando los dos envíos reales del navegador se ve cual es.
//
// Salida: /tmp/opencode/pair-<ts>.json (frames, con los tokens REDACTED).

import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 9298);
const MSG1 = process.argv[3] ?? "primero: recuerda que mi codigo es HALCON-4711";
const MSG2 = process.argv[4] ?? "segundo: cual era mi codigo?";
const OUT = `/tmp/opencode/pair-${Date.now()}.json`;

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
const cap = { sockets: [], frames: [], requests: [] };

ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.webSocketCreated":
			cap.sockets.push({ id: p.requestId, url: p.url });
			break;
		case "Network.webSocketFrameSent":
			cap.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 40000) });
			break;
		case "Network.webSocketFrameReceived":
			cap.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 40000) });
			break;
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/meta\.ai/.test(u) && /api\/graphql/.test(u))
				cap.requests.push({ url: u, postData: p.request.postData?.slice(0, 3000) ?? null, ts: Date.now() });
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
// siempre a la home: abre un chat NUEVO (los chats existentes no siempre
// exponen el composer de inmediato)
await call("Page.navigate", { url: "https://www.meta.ai/" });
await sleep(15000);

const composerSel = `(function () {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.getAttribute?.("contenteditable") === "true") {
        const rr = el.getBoundingClientRect();
        if (rr.width > 60 && rr.height > 8) out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName });
      }
    }
  };
  walk(document);
  return out[0] ?? null;
})()`;

async function send(text, waitMs) {
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
	await sleep(600);
	await call("Input.insertText", { text });
	await sleep(800);
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	console.error(`enviado: ${text.slice(0, 60)}`);
	await sleep(waitMs);
}

await send(MSG1, 22000);
await send(MSG2, 22000);

const clean = {
	capturedAt: new Date().toISOString(),
	sockets: cap.sockets.map((s) => ({ ...s, url: s.url.replace(/(Authorization=)ecto1%3A[^&]*/i, "$1ecto1%3AREDACTED") })),
	frames: cap.frames,
	requests: cap.requests,
};
fs.writeFileSync(OUT, JSON.stringify(clean, null, 1));
console.error("captura:", OUT, "| frames", cap.frames.length, "| requests graphql", cap.requests.length);
process.exit(0);
