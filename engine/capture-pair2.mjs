// capture-pair2.mjs — captura DEFINITIVA: dos mensajes del MISMO chat del front
// real, con todos los frames WS y todas las llamadas graphql.
//
//   node engine/capture-pair2.mjs [puertoCDP]
//
// Salida: /tmp/opencode/pair2-<ts>.json (token REDACTED).
//
// Por que existe: el navegador SI conserva el contexto entre mensajes del
// mismo chat. Capturar ese segundo request es la unica forma de saber que
// campo (o que llamada graphql) hace que el servidor use el historial del
// hilo y no el de otro chat de la misma cuenta.

import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 9298);
const OUT = `/tmp/opencode/pair2-${Date.now()}.json`;

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
			cap.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 90000) });
			break;
		case "Network.webSocketFrameReceived":
			cap.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 90000) });
			break;
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/api\/graphql/.test(u)) {
				cap.requests.push({ url: u, method: p.request.method, ts: Date.now(), postData: (p.request.postData ?? "").slice(0, 2000) });
			}
			break;
		}
		case "Network.responseReceived": {
			const u = p.response?.url ?? "";
			if (/api\/graphql/.test(u)) {
				cap.responses.push({ url: u, status: p.response.status, ts: Date.now() });
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

const requests0d = () => cap.frames.filter((f) => f.dir === "sent" && Buffer.from(f.data, "base64")[0] === 0x0d).length;

const composerSel = `(function () {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "TEXTAREA" || el.getAttribute?.("contenteditable") === "true") {
        const rr = el.getBoundingClientRect();
        if (rr.width > 60 && rr.height > 8 && rr.top < window.innerHeight - 20) {
          out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName });
        }
      }
    }
  };
  walk(document);
  return out[out.length - 1] ?? out[0] ?? null;
})()`;

// detecta si hay un boton de enviar visible
const sendBtnSel = `(function () {
  const cands = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("button,[role=button]")) {
      const rr = el.getBoundingClientRect();
      if (rr.width < 10 || rr.height < 10) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.textContent || "").toLowerCase();
      if (/send|enviar|submit|envia/.test(label)) cands.push({ x: rr.x + rr.width/2, y: rr.y + rr.height/2, label: label.slice(0,30) });
    }
    if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return cands[0] ?? null;
})()`;

async function enviar(texto) {
	const antes = requests0d();
	let rct = null;
	for (let i = 0; i < 30; i++) {
		rct = await ev2(composerSel);
		if (rct) break;
		await sleep(1000);
	}
	if (!rct) throw new Error("composer no aparecio");
	const x = Math.round(rct.x + rct.w / 2), y = Math.round(rct.y + rct.h / 2);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	await sleep(600);
	await call("Input.insertText", { text: texto });
	await sleep(700);
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	// si Enter no envio, se busca el boton de enviar
	for (let i = 0; i < 12; i++) {
		await sleep(1000);
		if (requests0d() > antes) return true;
		const btn = await ev2(sendBtnSel);
		if (btn) {
			await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(btn.x), y: Math.round(btn.y), button: "left", clickCount: 1 });
			await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(btn.x), y: Math.round(btn.y), button: "left", clickCount: 1 });
		}
	}
	return requests0d() > antes;
}

// espera a que la respuesta termine (dejan de llegar frames)
async function esperarFin(maxMs = 120000) {
	let ultimo = Date.now();
	let total = cap.frames.length;
	const t0 = Date.now();
	while (Date.now() - t0 < maxMs) {
		await sleep(3000);
		if (cap.frames.length !== total) { ultimo = Date.now(); total = cap.frames.length; }
		else if (Date.now() - ultimo > 12000) return true;
	}
	return false;
}

console.error("mensaje 1...");
const ok1 = await enviar("Mi codigo de proyecto es KILO-22. Responde solo ok");
console.error("  enviado:", ok1);
await esperarFin();

console.error("mensaje 2...");
const ok2 = await enviar("Cual es mi codigo de proyecto? Una palabra");
console.error("  enviado:", ok2);
await esperarFin(60000);

fs.writeFileSync(OUT, JSON.stringify({
	capturedAt: new Date().toISOString(),
	sockets: cap.sockets.map((s) => ({ ...s, url: String(s.url).replace(/(Authorization=)ecto1%3A[^&]*/i, "$1ecto1%3AREDACTED") })),
	frames: cap.frames,
	requests: cap.requests,
	responses: cap.responses,
}, null, 1));
console.error("captura:", OUT, "| requests 0x0d:", requests0d(), "| graphql:", cap.requests.length);
process.exit(0);
