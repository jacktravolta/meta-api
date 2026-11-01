// replay.mjs — reproduce la conversacion capturada desde Node, SIN navegador.
// Toma la ultima captura de engine/mirror-chat.mjs, extrae el token ecto1 y
// las cookies, y reenvia las tramas capturadas por el gateway. Si funciona,
// el motor protocol-first puede hablar con meta usando la sesion.
//
//   node engine/replay.mjs [ruta-captura]

import fs from "node:fs";
import path from "node:path";
import wsPkg from "ws";
const WS = wsPkg.WebSocket ?? wsPkg;
import { buildFrame, parseFrame, extractJsons, FRAME } from "./pb.mjs";
import { textOf } from "./gateway.mjs";

const files = fs.readdirSync("/tmp/opencode")
	.filter((f) => f.startsWith("mirror-") && f.endsWith(".json"))
	.map((f) => path.join("/tmp/opencode", f))
	.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const CAP = process.argv[2] ?? files[0];
if (!CAP) { console.error("sin captura en /tmp/opencode/mirror-*.json"); process.exit(1); }
const cap = JSON.parse(fs.readFileSync(CAP, "utf8"));
console.error("captura:", CAP);

const wsUrl = cap.sockets?.[0]?.url;
if (!wsUrl) { console.error("la captura no tiene socket"); process.exit(1); }
const u = new URL(wsUrl);
const token = u.searchParams.get("Authorization");
console.error("token:", token ? `${token.slice(0, 14)}…(${token.length} chars)` : "NO");

const cookie = (cap.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");
console.error("cookies:", (cap.cookies ?? []).map((c) => c.name).join(", "));

const sentFrames = cap.frames.filter((f) => f.dir === "sent").map((f) => Buffer.from(f.data, "base64"));
console.error("tramas enviadas capturadas:", sentFrames.length, sentFrames.map((b) => `0x${b[0].toString(16)}/${b.length}b`).join(" "));

const ws = new WS(wsUrl, {
	headers: {
		Cookie: cookie,
		Origin: "https://www.meta.ai",
		"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
	},
});

const texts = [];
let closed = null;
ws.on("open", () => {
	console.error("WS abierto (upgrade aceptado)");
	ws.send(buildFrame(FRAME.HANDSHAKE, JSON.stringify({
		"x-dgw-app-x-ecto-conversation-id": "11111111-2222-4333-8444-555555555555",
		"x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
	})));
});
ws.on("message", (data) => {
	const b = Buffer.from(data);
	if (b.length === 1) { console.error("keepalive 0x" + b[0].toString(16)); return; }
	let parsed;
	try { parsed = parseFrame(b); } catch (e) { console.error("frame no parseable:", e.message); return; }
	console.error(`recv tipo=0x${parsed.type.toString(16)} ${parsed.payload?.length ?? 0}b`);
	if (parsed.type === FRAME.DATA) {
		for (const j of extractJsons(parsed.payload)) {
			const t = j.type === "full" && j.response ? textOf(j.response) : (j.sections ? textOf(j) : null);
			if (t) { texts.push(t); console.log(`[META] ${t}`); }
			if (j.type === "patch" && (j.operations ?? []).length === 0) {
				console.error("fin de stream (patch vacio)");
				ws.close();
			}
		}
	}
	if (parsed.type === FRAME.HANDSHAKE) console.error("handshake srv:", parsed.payload.toString("utf8").slice(0, 120));
});
ws.on("close", (code, reason) => { closed = { code, reason: reason?.toString() }; });
ws.on("error", (e) => console.error("ws error:", e.message));

// reenviar las tramas capturadas (en handshake primero)
setTimeout(() => {
	for (const b of sentFrames) {
		if (b[0] === FRAME.HANDSHAKE) continue; // ya enviamos el nuestro
		ws.send(b);
		console.error(`reenviada trama 0x${b[0].toString(16)} (${b.length}b)`);
	}
}, 1200);

setTimeout(() => {
	console.error("cierre:", JSON.stringify(closed));
	console.error("textos:", JSON.stringify(texts));
	ws.close();
	process.exit(texts.length ? 0 : 3);
}, 25000);
