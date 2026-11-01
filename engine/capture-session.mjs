// capture-session.mjs — captura la credencial de sesion propia (token ecto1 +
// cookies) SIN enviar ningun mensaje a meta (no deja chats sueltos en la
// cuenta). Solo abre la pagina y lee la URL del WebSocket + las cookies.
//
//   node engine/capture-session.mjs [puertoCDP]
//
// Guarda en engine/.session.json (0600, fuera de git).

import fs from "node:fs";
import * as session from "./session.mjs";

const PORT = Number(process.argv[2] ?? 9298);

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let page = tabs.find((t) => t.type === "page" && /meta\.ai/.test(t.url));
if (!page) {
	// abrir pestana nueva
	const res = await fetch(`http://127.0.0.1:${PORT}/json/new?https://www.meta.ai/`, { method: "PUT" });
	page = await res.json();
}
console.error("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 1;
const pending = new Map();
let socketUrl = null;

ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	if (m.method === "Network.webSocketCreated" && /gateway\.meta\.ai/.test(p.url ?? "")) {
		socketUrl = p.url;
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await call("Network.enable");
await call("Page.enable");
if (!/meta\.ai/.test(page.url)) {
	await call("Page.navigate", { url: "https://www.meta.ai/" });
}

// esperar el WS del gateway
for (let i = 0; i < 40 && !socketUrl; i++) await new Promise((r) => setTimeout(r, 500));
if (!socketUrl) { console.error("no se abrio el WS del gateway"); process.exit(3); }

const ck = await call("Network.getAllCookies");
const cookies = (ck?.cookies ?? []).filter((c) => /meta\.ai/.test(c.domain ?? ""));
const token = new URL(socketUrl).searchParams.get("Authorization");
if (!token) { console.error("el WS no trae Authorization"); process.exit(3); }

const creds = {
	token,
	cookies: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
	userId: null,
	capturedAt: new Date().toISOString(),
	source: "capture-session.mjs",
};
console.error("token:", token.slice(0, 12) + "…", "| cookies:", cookies.map((c) => c.name).join(", "));
session.save(creds);
console.error("guardado:", session.FILE);
process.exit(0);
