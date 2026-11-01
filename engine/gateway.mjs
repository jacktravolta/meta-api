// gateway.mjs — cliente del gateway DGW/clippy de meta.ai (zero-deps, Node 22).
// Contrato: engine/PROTOCOL.md · fixture: engine/fixtures/capture-ws-20261031.json
//
// El pb del request se construye sobre el ENVELOPE capturado (template) con
// slots mutables: prompt (f2.2), turn uuid, ts, ids de conversacion. Los campos
// desconocidos pasan intactos — esa es la defensa frente a drift de protocolo:
// si Meta agrega campos, el template sigue funcionando hasta que el servidor
// exija algo que el capturado no lleva.
//
// Seguridad: el token ecto1: llega por argumento, NUNCA se loguea.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
	FRAME, buildFrame, parseFrame,
	decodePb, encodePb, extractJsons,
} from "./pb.mjs";

export const PROTOCOL = {
	GATEWAY_URL: "wss://gateway.meta.ai/ws/clippy",
	APP_ID: "1522763855472543",
	APP_VERSION: "1.0.0",
	AUTH_TYPE: "15:0", // ABRA
	DGW_VERSION: "5",
	TIER: "prod",
	ORIGIN: "meta.ai",
};

// Codigos de cierre documentados (bundle 1hevzi2weu6be.js, modulo DGW)
export const CLOSE = {
	NORMAL: 1000, GOING_AWAY: 1001, ABNORMAL: 1006,
	SERVER_INTERNAL: 1011, GRACEFUL: 4000, KEEPALIVE_TIMEOUT: 4001,
	DGW_SERVER_ERROR: 4002, UNAUTHORIZED: 4003, REJECTED: 4004, BAD_REQUEST: 4005,
};

const CLOSE_NAMES = Object.fromEntries(Object.entries(CLOSE).map(([k, v]) => [v, k]));

const PING_INTERVAL_MS = 25_000;

// Valores capturados (fixture); solo para match por igualdad en los slots
const CAPTURED = {
	conversationId: "29cb0c02-c081-4f5f-a63d-5637c3ee9225",
	turnId: "5d838aa8-7de2-4909-848a-22f39edb479c",
	prompt: "responde solo: hola",
};

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/capture-ws-20261031.json");

function loadTemplate() {
	const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
	const dataFrame = fixture.frames
		.map((f) => Buffer.from(f.data, "base64"))
		.find((b) => b[0] === FRAME.DATA && b[7] === FRAME.FLAG_CLIENT);
	if (!dataFrame) throw new Error("fixture sin frame de envio");
	const sent = JSON.parse(dataFrame.subarray(8).toString("utf8"));
	return { reqId: sent["req-id"], payload: decodePb(Buffer.from(sent.payload, "base64")) };
}

// ---------- slots ----------

// Sustituye slots por igualdad de valor sobre el arbol decodificado.
// replaced == 0 => drift de protocolo: mejor fallar que mandar pbs corruptos.
export function insertSlots(nodes, { prompt, conversationId, turnId }) {
	let replaced = 0;
	const visit = (list) => {
		for (const n of list) {
			if (n.wire !== 2) continue;
			if (n.kind === "str") {
				if (n.str === CAPTURED.conversationId) { n.str = conversationId; replaced++; }
				else if (n.str === CAPTURED.turnId) { n.str = turnId; replaced++; }
			} else if (n.kind === "pb") {
				visit(n.pb);
			}
		}
	};
	visit(nodes);
	const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
	if (!msg) throw new Error("template: sin mensaje (f2)");
	const leaf = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str");
	if (!leaf) throw new Error("template: sin slot de prompt (f2.2)");
	if (leaf.str !== CAPTURED.prompt) throw new Error("template: slot de prompt no matchea (drift)");
	leaf.str = prompt;
	replaced++;
	return { replaced };
}

export function buildRequestPayload({ prompt, conversationId, turnId = randomUUID() }) {
	const { payload } = loadTemplate();
	// clon profundo (bigint es inmutable; solo clono el arbol de nodos)
	const deepClone = (list) => list.map((n) => {
		const c = { field: n.field, wire: n.wire };
		if (n.wire === 0) c.varint = n.varint;
		else {
			c.kind = n.kind;
			if (n.kind === "str") c.str = n.str;
			else if (n.kind === "pb") c.pb = deepClone(n.pb);
			else c.bytes = n.bytes;
		}
		return c;
	});
	const nodes = deepClone(payload);
	const { replaced } = insertSlots(nodes, { prompt, conversationId, turnId });
	return { payload: encodePb(nodes), replaced, reqId: randomUUID() };
}

// ---------- cliente ----------

export class GatewayError extends Error {
	constructor(code, msg) {
		super(`gateway cerrado ${code} (${CLOSE_NAMES[code] ?? "desconocido"}): ${msg}`);
		this.name = "GatewayError";
		this.code = code;
	}
}

export class MetaGateway {
	constructor({ token, conversationId = randomUUID(), pingMs = PING_INTERVAL_MS, debug = false }) {
		if (!token) throw new TypeError("MetaGateway: falta token ecto1:");
		this.token = token;
		this.conversationId = conversationId;
		this.pingMs = pingMs;
		this.debug = debug;
		this.ws = null;
		this.#q = [];
		this.#waiting = null;
	}

	#q;
	#waiting;
	#pingTimer = null;
	#openRes = null;
	#openRej = null;
	#closed = null;

	url() {
		const p = new URLSearchParams({
			"x-dgw-appid": PROTOCOL.APP_ID,
			"x-dgw-appversion": PROTOCOL.APP_VERSION,
			"x-dgw-authtype": PROTOCOL.AUTH_TYPE,
			"x-dgw-version": PROTOCOL.DGW_VERSION,
			"x-dgw-uuid": "0",
			"x-dgw-tier": PROTOCOL.TIER,
			"Authorization": `ecto1:${this.token}`,
			"x-dgw-app-origin": PROTOCOL.ORIGIN,
			"x-dgw-app-clippy-request-id": randomUUID(),
		});
		return `${PROTOCOL.GATEWAY_URL}?${p.toString()}`;
	}

	#log(...a) { if (this.debug) console.error("[gateway]", ...a); }

	#flush() {
		if (this.#waiting && this.#q.length) {
			const d = this.#q.shift();
			const w = this.#waiting; this.#waiting = null;
			w(d);
		}
	}

	#readFrame() {
		if (this.#q.length) return Promise.resolve(this.#q.shift());
		return new Promise((res) => { this.#waiting = res; });
	}

	#onError(err) {
		this.#log("ws error", err?.message ?? err);
		const rej = this.#openRej; this.#openRej = null; this.#openRes = null;
		rej?.(err ?? new Error("ws error"));
	}

	#onData(data) {
		if (data.length === 1) this.#q.push({ keepalive: true, type: data[0] });
		else {
			try { this.#q.push(parseFrame(data)); }
			catch (err) { this.#q.push({ error: err }); }
		}
		this.#flush();
	}

	#onClose(code, reason) {
		clearInterval(this.#pingTimer);
		this.#closed = { code, reason: reason?.toString?.() ?? "" };
		const rej = this.#openRej; this.#openRej = null; this.#openRes = null;
		rej?.(new GatewayError(code, this.#closed.reason || "cerrado"));
	}

	async connect() {
		const url = this.url();
		this.#log("conectando", url.replace(this.token, "REDACTED"));
		const ws = this.ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		ws.onerror = (e) => this.#onError(e?.error ?? new Error("ws error"));
		ws.onclose = (e) => this.#onClose(e.code, e.reason);
		ws.onmessage = (e) => {
			const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
			this.#onData(data);
		};
		await new Promise((res, rej) => { this.#openRes = res; this.#openRej = rej; });
		ws.send(new Uint8Array(buildFrame(FRAME.HANDSHAKE, JSON.stringify({
			"x-dgw-app-x-ecto-conversation-id": this.conversationId,
			"x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
		}))));
		const hs = await this.#readFrame();
		if (hs.error) throw hs.error;
		if (hs.type !== FRAME.HANDSHAKE) throw new GatewayError(CLOSE.BAD_REQUEST, `handshake: tipo 0x${hs.type?.toString(16)}`);
		const code = JSON.parse(hs.payload.toString("utf8")).code;
		if (code !== 200) throw new GatewayError(CLOSE.UNAUTHORIZED, `handshake code ${code}`);
		this.#pingTimer = setInterval(() => {
			if (ws.readyState === 1) ws.send(new Uint8Array(FRAME.PING));
		}, this.pingMs);
		return { conversationId: this.conversationId };
	}

	// Envia un prompt y acumula el stream. onText(textoAcumulado) opcional.
	// Resuelve al llegar patch vacio; luego close o seguir listo con el mismo ws.
	async chat(prompt, { onText } = {}) {
		if (!this.ws || this.ws.readyState !== 1 || this.#closed)
			throw new Error("chat: gateway no conectado");
		const { payload, replaced, reqId } = buildRequestPayload({ prompt, conversationId: this.conversationId });
		if (replaced < 2) throw new Error(`template: ${replaced} slots — drift de protocolo probable`);
		this.ws.send(new Uint8Array(buildFrame(FRAME.DATA,
			JSON.stringify({ "req-id": reqId, payload: payload.toString("base64") }),
			FRAME.FLAG_CLIENT)));

		let lastFull = null;
		for (;;) {
			const fr = await this.#readFrame();
			if (this.#closed) throw new GatewayError(this.#closed.code, this.#closed.reason || "cerrado en stream");
			if (fr.error) throw fr.error;
			if (fr.keepalive) continue;
			if (fr.type === FRAME.ACK || fr.type === FRAME.HANDSHAKE) continue;
			if (fr.type !== FRAME.DATA) { this.#log("frame no manejado", fr); continue; }
			for (const j of extractJsons(fr.payload)) {
				if (j.type === "patch") {
					const ops = j.operations ?? [];
					if (ops.length === 0 && j.seq > 0) return { text: lastFull, reqId };
					this.#log("patch con operaciones (forma por confirmar):", JSON.stringify(j).slice(0, 400));
				} else {
					const t = textOf(j.response ?? j);
					if (t !== null) { lastFull = t; onText?.(t); }
				}
			}
		}
	}

	close() {
		clearInterval(this.#pingTimer);
		try { this.ws?.close(1000); } catch {}
	}
}

// sections[].view_model.primitive — texto si es primitive de texto
export function textOf(response) {
	const out = [];
	for (const s of response?.sections ?? []) {
		const prim = s?.view_model?.primitive ?? {};
		if (prim.__typename === "GenAIMarkdownTextUXPrimitive" && typeof prim.text === "string")
			out.push(prim.text);
	}
	return out.length ? out.join("\n") : null;
}
