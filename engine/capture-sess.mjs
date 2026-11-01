// capture-sess.mjs — captura el protocolo autenticado contra meta.ai usando la
// copia del perfil (chrome 9298 ya corriendo). Guarda requests+respuestas en
// /tmp/opencode/capture-sess.json. Nunca imprime valores de cookies.

import { writeFileSync } from "node:fs";

const PORT = 9298;
const OUT = "/tmp/opencode/capture-sess.json";
const PROMPT = "responde en una sola palabra: ping";

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let page = tabs.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 1;
const pending = new Map();
const captured = [];
const inflight = new Map();
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	if (m.method === "Network.requestWillBeSent") {
		const u = p.request?.url ?? "";
		if (/meta\.ai/.test(u) && /(graphql|api\/|__rd_verify|suspected|auth)/.test(u) && !/_next\/static|analytics|woff/.test(u)) {
			inflight.set(p.requestId, {
				url: u,
				method: p.request.method,
				headers: p.request.headers,
				postData: p.request.postData?.slice(0, 6000) ?? null,
			});
		}
	}
	if (m.method === "Network.responseReceived" && inflight.has(p.requestId)) {
		const req = inflight.get(p.requestId);
		req._rid = p.requestId;
		req.status = p.response.status;
		captured.push(req);
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r?.result?.value);

await call("Network.enable");
await call("Page.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });

// composer autenticado: el DIV Lexical contenteditable (hay un textarea oculto 0x0 que engana)
let ready = false;
let waitUntil = Date.now() + 45000;
while (Date.now() < waitUntil) {
	const n = await ev2(`document.querySelectorAll('div[contenteditable="true"]').length`);
	if (n > 0) { ready = true; break; }
	await new Promise((r) => setTimeout(r, 1000));
}
console.error(`composer: ${ready} | login visible: ${await ev2(`!!document.body.innerText.match(/iniciar sesi/i)`)}`);

if (ready) {
	const rectStr = await ev2(`JSON.stringify(document.querySelector('div[contenteditable="true"]').getBoundingClientRect())`);
	const r = JSON.parse(rectStr);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), button: "left", clickCount: 1 });
	await new Promise((r2) => setTimeout(r2, 700));
	await call("Input.insertText", { text: PROMPT });
	await new Promise((r2) => setTimeout(r2, 1200));
	console.error("campo:", await ev2(`JSON.stringify(document.querySelector('div[contenteditable="true"]').textContent.slice(0,60))`));
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	console.error("enter disparado...");
}
// clic explicito en el boton de envio real (aria-label="Enviar") por si el Enter no submitteo
const btn = await ev2(`JSON.stringify((() => { const b = [...document.querySelectorAll('button[aria-label="Enviar"], button[aria-label="Send"], button[aria-label*="envi" i]')].find((x) => !x.disabled && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`);
if (btn && btn !== "null") {
	const b = JSON.parse(btn);
	console.error("boton Enviar en", Math.round(b.x), Math.round(b.y));
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2), button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2), button: "left", clickCount: 1 });
} else {
	console.error("sin boton de enviar visible");
}

await new Promise((r) => setTimeout(r, 60000));
const shot = await call("Page.captureScreenshot");
if (shot?.data) writeFileSync("/tmp/opencode/sessshot.png", Buffer.from(shot.data, "base64"));
console.error("texto actual:", await ev2(`document.body.innerText.slice(0, 200).replace(/\n+/g, " | ")`));

for (const c of captured) {
	try {
		const b = await call("Network.getResponseBody", { requestId: c._rid });
		c.responseBody = (b.body ?? "").slice(0, 30000);
	} catch { c.responseBody = null; }
}
ws.close();
writeFileSync(OUT, JSON.stringify({ requests: captured }, null, 1));
console.error(`listo: ${captured.length} requests -> ${OUT}`);
process.exit(0);
