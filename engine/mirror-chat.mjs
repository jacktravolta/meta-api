// mirror-chat.mjs — envia un prompt a meta.ai con tu sesion y REFLEJA la
// conversacion aqui (terminal), ademas de capturar el trafico del gateway.
//
//   node engine/mirror-chat.mjs "hola" [puertoCDP]
//
// Escribe el trafico capturado en /tmp/opencode/mirror-<ts>.json (con token y
// cookies en claro para poder reutilizarlos — NUNCA se commitea).

import { writeFileSync } from "node:fs";
import { parseFrame, extractJsons, FRAME } from "./pb.mjs";
import { textOf } from "./gateway.mjs";

const PROMPT = process.argv[2] ?? "responde en una sola palabra: ping";
const PORT = Number(process.argv[3] ?? 9298);
const OUT = `/tmp/opencode/mirror-${Date.now()}.json`;

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = tabs.find((t) => t.type === "page" && /^https?:/.test(t.url) && !/languagetool/.test(t.url))
	?? tabs.find((t) => t.type === "page" && !/languagetool/.test(t.url));
if (!page) { console.error("sin page target"); process.exit(1); }
console.error("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 1;
const pending = new Map();
const cap = { sockets: [], frames: [], requests: [], bodies: [], cookies: [], transcript: [] };
const bodyWaiters = new Map();

ws.onmessage = async (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/meta\.ai/.test(u) && /api\/graphql/.test(u)) {
				cap.requests.push({ url: u, method: p.request.method, postData: p.request.postData?.slice(0, 2000) ?? null, ts: Date.now() });
				bodyWaiters.set(p.requestId, u);
			}
			break;
		}
		case "Network.loadingFinished": {
			const u = bodyWaiters.get(p.requestId);
			if (u) {
				try {
					const r = await call("Network.getResponseBody", { requestId: p.requestId });
					if (r?.body) cap.bodies.push({ url: u, body: r.body.slice(0, 5000), ts: Date.now() });
				} catch { /* no disponible */ }
			}
			break;
		}
		case "Network.webSocketCreated":
			cap.sockets.push({ id: p.requestId, url: p.url, ts: Date.now() });
			console.error("WS:", p.url.replace(/(Authorization=ecto1%3A)[^&]*/i, "$1<TOKEN>"));
			break;
		case "Network.webSocketFrameSent":
			cap.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 20000) });
			break;
		case "Network.webSocketFrameReceived":
			cap.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 20000) });
			break;
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);

await call("Network.enable");
await call("Page.enable");
await call("Runtime.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
await new Promise((r) => setTimeout(r, 15000));

// composer (el front nuevo vive dentro de shadow roots)
const composerSel = `(function () {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.getAttribute?.("contenteditable") === "true") {
        const rr = el.getBoundingClientRect();
        if (rr.width > 60 && rr.height > 8) out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName, ph: el.getAttribute?.("placeholder") ?? "" });
      }
    }
  };
  walk(document);
  return out[0] ?? null;
})()`;
let rct = null;
for (let i = 0; i < 20; i++) {
	rct = await ev2(composerSel);
	if (rct) break;
	await new Promise((r) => setTimeout(r, 1500));
}
if (!rct) { console.error("composer no aparecio"); process.exit(1); }
console.error(`composer ok (${rct.tag})`);

const x = Math.round(rct.x + rct.w / 2), y = Math.round(rct.y + rct.h / 2);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 600));
await call("Input.insertText", { text: PROMPT });
await new Promise((r) => setTimeout(r, 800));
console.log(`\n[TU] ${PROMPT}\n`);
await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });

// reflejo en vivo: texto del asistente via los frames del gateway
const seen = new Set();
let finalText = null;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
	for (const fr of cap.frames) {
		if (fr.dir !== "recv" || seen.has(fr.ts + fr.data.length)) continue;
		seen.add(fr.ts + fr.data.length);
		let parsed;
		try { parsed = parseFrame(Buffer.from(fr.data, "base64")); } catch { continue; }
		if (parsed.type !== FRAME.DATA) continue;
		for (const j of extractJsons(parsed.payload)) {
			const t = j.type === "full" && j.response ? textOf(j.response) : (j.sections ? textOf(j) : null);
			if (t && t !== finalText) {
				finalText = t;
				process.stdout.write(`[META] ${t.replace(/\n/g, "\n       ")}\n`);
			}
		}
	}
	await new Promise((r) => setTimeout(r, 700));
}

const ck = await call("Network.getAllCookies");
cap.cookies = (ck?.cookies ?? []).filter((c) => /meta\.ai/.test(c.domain)).map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
cap.transcript.push({ role: "user", text: PROMPT }, { role: "meta", text: finalText });
writeFileSync(OUT, JSON.stringify(cap, null, 1));
console.error(`\ncaptura: ${OUT} | sockets ${cap.sockets.length} | frames ${cap.frames.length} | cookies meta ${cap.cookies.length}`);
console.error("cookie names:", cap.cookies.map((c) => c.name).join(", "));
process.exit(finalText ? 0 : 3);
