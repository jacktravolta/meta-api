// capture-guest.mjs — captura el flujo INVITADO (sin login) del front de meta.ai.
// Perfil throwaway en /tmp: cero datos del usuario, cero cuentas.
// Graba: WS frames, respuestas de /api/graphql (incluye el accessToken invitado),
// cookies y el estado del composer (si el invitado puede chatear o hay muro de login).
//
// Uso: node engine/capture-guest.mjs [puertoCDP]

import { writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 9299);
const OUT = "/tmp/opencode/capture-guest.json";
const PROMPT = "responde en una sola palabra: ping";

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = tabs.find((t) => t.type === "page") ?? tabs[0];
if (!page) { console.error("sin page target"); process.exit(1); }
console.error("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 1;
const pending = new Map();
const log = { requests: [], sockets: [], frames: [], bodies: [], cookies: [], notes: [] };
const bodyWaiters = new Map();

ws.onmessage = async (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	switch (m.method) {
		case "Network.requestWillBeSent": {
			const u = p.request?.url ?? "";
			if (/meta\.ai/.test(u) && /api\/graphql|auth|token|clippy/.test(u)) {
				log.requests.push({ url: u, method: p.request.method, headers: p.request.headers, postData: p.request.postData?.slice(0, 4000) ?? null, ts: Date.now() });
				bodyWaiters.set(p.requestId, u);
			}
			break;
		}
		case "Network.responseReceived": {
			const u = p.response?.url ?? "";
			if (/api\/graphql/.test(u)) bodyWaiters.set(p.requestId, u);
			break;
		}
		case "Network.loadingFinished": {
			const u = bodyWaiters.get(p.requestId);
			if (u && /api\/graphql/.test(u)) {
				try {
					const r = await call("Network.getResponseBody", { requestId: p.requestId });
					if (r?.body) log.bodies.push({ url: u, body: r.body.slice(0, 6000) });
				} catch { /* body no disponible */ }
			}
			break;
		}
		case "Network.webSocketCreated":
			log.sockets.push({ id: p.requestId, url: p.url, ts: Date.now() });
			break;
		case "Network.webSocketFrameSent":
			log.frames.push({ dir: "sent", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 12000) });
			break;
		case "Network.webSocketFrameReceived":
			log.frames.push({ dir: "recv", id: p.requestId, ts: Date.now(), data: (p.response?.payloadData ?? "").slice(0, 12000) });
			break;
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);

await call("Network.enable");
await call("Page.enable");
await call("Runtime.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
await new Promise((r) => setTimeout(r, 18000));

// cookies (el WS del browser NO los manda si son cross-site; lo comprobamos)
const ck = await call("Network.getAllCookies");
log.cookies = (ck?.cookies ?? []).map((c) => ({ name: c.name, domain: c.domain, value: c.value, sameSite: c.sameSite, secure: c.secure }));
log.notes.push("cookies: " + log.cookies.map((c) => `${c.name}@${c.domain}`).join(", "));

// estado del composer para invitados
const composerSel = `(function () {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.getAttribute?.("contenteditable") === "true") {
        const rr = el.getBoundingClientRect();
        if (rr.width > 60 && rr.height > 8) out.push({ x: rr.x, y: rr.y, w: rr.width, h: rr.height, tag: el.tagName, ph: el.getAttribute?.("placeholder") ?? "", disabled: !!el.disabled });
      }
    }
  };
  walk(document);
  return out;
})()`;
let composers = [];
for (let i = 0; i < 14; i++) {
	composers = (await ev2(composerSel)) ?? [];
	if (composers.length) break;
	await new Promise((r) => setTimeout(r, 1500));
}
log.notes.push("composers: " + JSON.stringify(composers).slice(0, 400));

// texto visible de la pagina: detectar muro de login
const pageText = await ev2(`document.body.innerText.slice(0, 1200)`);
log.notes.push("texto pagina: " + String(pageText).replace(/\s+/g, " ").slice(0, 600));

if (composers.length) {
	const rct = composers[0];
	const x = Math.round(rct.x + rct.w / 2), y = Math.round(rct.y + rct.h / 2);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	await new Promise((r) => setTimeout(r, 800));
	await call("Input.insertText", { text: PROMPT });
	await new Promise((r) => setTimeout(r, 700));
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	log.notes.push("prompt enviado al composer invitado");
	await new Promise((r) => setTimeout(r, 30000));
} else {
	// sin composer: intentar click en un starter (tarjeta de conversacion)
	const clicked = await ev2(`(function () {
		const els = [...document.querySelectorAll("button, [role=button], a")].filter(e => /conversation|starter|prompt|ask|pregunta/i.test(e.innerText || ""));
		if (!els.length) return null;
		els[0].click();
		return (els[0].innerText || "").slice(0, 80);
	})()`);
	log.notes.push("starter click: " + JSON.stringify(clicked));
	await new Promise((r) => setTimeout(r, 8000));
	const composers2 = (await ev2(composerSel)) ?? [];
	log.notes.push("composers post-starter: " + JSON.stringify(composers2).slice(0, 300));
}

const ck2 = await call("Network.getAllCookies");
log.cookies = (ck2?.cookies ?? []).map((c) => ({ name: c.name, domain: c.domain, value: c.value, sameSite: c.sameSite, secure: c.secure }));

ws.close();
writeFileSync(OUT, JSON.stringify(log, null, 1));
console.error(`requests: ${log.requests.length} | bodies: ${log.bodies.length} | sockets: ${log.sockets.length} | frames: ${log.frames.length}`);
for (const n of log.notes) console.error("  -", n);
for (const s of log.sockets) console.error("  socket:", s.url.replace(/(Authorization=ecto1%3A)[^&]*/i, "$1REDACTED"));
process.exit(0);
