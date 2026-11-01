// capture-auth.mjs — reverse-engineering del protocolo AUTENTICADO de meta.ai.
// Lanza Chrome headless con el REAL perfil logueado, dispara un prompt y captura
// TODO el trafico de API del envio: headers, bodies y respuestas NDJSON.
// Requiere que el broker este detenido (perfil de Chrome libre).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9299;
const PROFILE = process.env.META_PROFILE || "/home/test/.config/google-chrome-beta-debug";
const BIN = process.env.CHROME_BIN || "/usr/bin/google-chrome-beta";
const OUT = "/tmp/opencode/capture-auth.json";
const PROMPT = "responde en una sola palabra: ping";

const chrome = spawn(BIN, [
	"--headless=new",
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${PROFILE}`,
	"--no-first-run",
	"--window-size=1280,900",
	// el broker usa estas mismas minimizaciones para no ensuciar la sesion
	"--disable-features=Translate", "--disable-breakpad",
], { stdio: ["ignore", "ignore", "ignore"] });

let page;
const dl = Date.now() + 20000;
while (Date.now() < dl) {
	try {
		const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
		if (t?.length) { page = t.find((x) => x.type === "page"); break; }
	} catch {}
	await new Promise((r) => setTimeout(r, 400));
}
if (!page) { console.error("sin pagina CDP"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 1;
const pending = new Map();
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	onEvent(m);
};
const call = (method, params = {}) =>
	new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev2 = (expr) => call("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r?.result?.value);

// --- captura: TODO request de meta.ai con metodo POST o ruta de API ---
const captured = [];
const inflight = new Map();
const onEvent = (m) => {
	const p = m.params ?? {};
	if (m.method === "Network.requestWillBeSent") {
		const u = p.request?.url ?? "";
		const hostOk = /meta\.ai/.test(u);
		const apiOk = /(graphql|state|api\/|__rd_verify)/.test(u) && (p.request.method !== "GET" || /__rd_verify|state|auth/.test(u));
		if (hostOk && apiOk) {
			inflight.set(p.requestId, {
				url: u,
				method: p.request.method,
				headers: p.request.headers,
				postData: p.request.postData?.slice(0, 5000) ?? null,
				ts: Date.now(),
			});
		}
	}
	if (m.method === "Network.responseReceived" && inflight.has(p.requestId)) {
		const req = inflight.get(p.requestId);
		req._rid = p.requestId;
		req.status = p.response.status;
		req.responseHeaders = p.response.headers;
		captured.push(req);
	}
};

await call("Network.enable");
await call("Page.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });

// espera el composer: input por placeholder (el guest no usa contenteditable)
let composer = null;
let waitUntil = Date.now() + 40000;
while (Date.now() < waitUntil) {
	const n = await ev2(`document.querySelectorAll('input[placeholder*="Meta AI" i], [contenteditable="true"], textarea').length`);
	if (n > 0) { composer = true; break; }
	await new Promise((r) => setTimeout(r, 1000));
}
console.error(`composer: ${composer}`);

if (composer) {
	// rect real del input para el click
	const rectStr = await ev2(`JSON.stringify((document.querySelector('input[placeholder*="Meta AI" i]') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea')).getBoundingClientRect())`);
	const rect = JSON.parse(rectStr);
	await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), button: "left", clickCount: 1 });
	await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), button: "left", clickCount: 1 });
	await new Promise((r2) => setTimeout(r2, 600));
	await call("Input.insertText", { text: PROMPT });
	await new Promise((r2) => setTimeout(r2, 1200));
	console.error("texto insertado, campo:", await ev2(`JSON.stringify((document.querySelector('input[placeholder*="Meta AI" i]') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea'))?.value ?? document.body.querySelector('[contenteditable="true"]')?.textContent ?? null)`));
	await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	console.error("enter disparado");
}

// ventana de streaming: 35s tras el envio
await new Promise((r) => setTimeout(r, 35000));

// cuerpos de respuesta
for (const c of captured) {
	try {
		const b = await call("Network.getResponseBody", { requestId: c._rid });
		c.responseBody = (b.body ?? "").slice(0, 20000);
	} catch {
		c.responseBody = null;
	}
}

// cookies de la sesion
const cookies = await call("Storage.getCookies").then(
	(r) => (r?.cookies ?? []).filter((c) => /meta\.ai$/.test(c.domain)).map(({ name, value, domain, path, expires }) => ({ name, value, domain: String(domain), path, expires })),
);

// consistencia: _rid no lo seteo en inflight — lo hago arriba
ws.close();
chrome.kill("SIGKILL");
writeFileSync(OUT, JSON.stringify({ requests: captured, cookies }, null, 1));
console.error(`listo: ${captured.length} requests capturados -> ${OUT}`);
process.exit(0);
