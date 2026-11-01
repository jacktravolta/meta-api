// capture.mjs — captura el trafico real de meta.ai para reverse-engineer el protocolo actual.
// Lanza Chrome headless con perfil desechable, abre meta.ai y registra los requests
// a endpoints de API (graphql / state / auth) con headers, body y respuesta.
// NO usa el perfil real ni toca el broker: todo en /tmp.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9299;
const BIN = process.env.CHROME_BIN || "/usr/bin/google-chrome-beta";
const PROFILE = mkdtempSync(join(tmpdir(), "metaai-capture-"));
const OUT = process.argv[2] || "/tmp/opencode/capture.json";
const WAIT_MS = Number(process.argv[3] || 15000);

const chrome = spawn(BIN, [
	"--headless=new",
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${PROFILE}`,
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--window-size=1280,900",
	"https://www.meta.ai/",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", (d) => {
	const s = String(d);
	if (/DevTools listening/.test(s)) console.error("chrome listo:", s.trim());
});

// espera el puerto CDP
const deadline = Date.now() + 20000;
let targets = null;
while (Date.now() < deadline) {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/json`);
		targets = await r.json();
		if (targets?.length) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 1;
const pending = new Map();
const capture = [];
const bodies = new Map(); // requestId -> request info
let eventCount = 0;
const firstUrls = [];

ws.onmessage = (ev) => {
	eventCount++;
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m.result ?? m.error);
		pending.delete(m.id);
		return;
	}
	const p = m.params ?? {};
	const u = p.request?.url ?? "";
	let host = "";
	try {
		host = new URL(u).hostname;
	} catch {
		// urls vacias o data: no interesan
	}
	const isApi = /(^|\.)meta\.ai$/.test(host) || /graph\.meta\.ai/.test(u);
	if (m.method === "Network.requestWillBeSent") {
		if (firstUrls.length < 10) firstUrls.push(u || "(sin url)");
	}
	if (m.method === "Network.requestWillBeSent" && isApi) {
		bodies.set(p.requestId, {
			url: p.request.url,
			method: p.request.method,
			headers: p.request.headers,
			postData: p.request.postData?.slice(0, 4000) ?? null,
		});
	}
	if (m.method === "Network.responseReceived" && isApi && bodies.has(p.requestId)) {
		const req = bodies.get(p.requestId);
		req._id = p.requestId;
		req.status = p.response.status;
		req.responseHeaders = p.response.headers;
		capture.push(req);
	}
};

const call = (method, params = {}) =>
	new Promise((r) => {
		const id = seq++;
		pending.set(id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});

await call("Network.enable");
await call("Page.enable");
console.error("capturando", WAIT_MS, "ms...");
// navegar explicito: el usuario de la URL del spawn dispara el load antes del enable
await call("Page.navigate", { url: "https://www.meta.ai/?q=" + encodeURIComponent("responde hola en una frase") });
await new Promise((r) => setTimeout(r, WAIT_MS));

// cuerpos de respuesta: los pedimos aparte (getResponseBody no llega por eventos)
for (const c of capture) {
	try {
		const b = await call("Network.getResponseBody", { requestId: c._id });
		c.responseBody = (b.body ?? "").slice(0, 6000);
	} catch {
		c.responseBody = null;
	}
}
ws.close();
chrome.kill("SIGKILL");
writeFileSync(OUT, JSON.stringify(capture, null, 1));
console.error(`listo: ${capture.length} requests de API en ${OUT} | eventos CDP: ${eventCount} | primeros urls появи: ${firstUrls.length}`);
process.exit(0);
