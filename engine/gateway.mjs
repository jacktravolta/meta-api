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
import wsPkg from "ws";
import {
	FRAME, buildFrame, parseFrame,
	decodePb, encodePb, extractJsons,
} from "./pb.mjs";

// `ws` es CommonJS y permite headers (Cookie, Origin) en el upgrade HTTP;
// el WebSocket global de Node no los soporta.
const WS = wsPkg.WebSocket ?? wsPkg;

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
	playerId: "867051314767696", // id de la cuenta logueada en la captura
	reqId: "5652aa8a-ab17-4477-af92-16c47568e7e5",
	appSession: "5a5b-8d4e-f054-99ef-b2de-db02-0d05-52c7",
	flowId1: "e6b67af6-9f4e-4f26-ad1e-84146b684328",
	flowId2: "24e944cb-b5d1-43f2-99b5-79cf34e19648",
	tsA: 1793499023080n,
	tsB: 1793499022423n,
	tsC: 1793499023090n,
};

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// el template es la captura mas reciente (ordenada por nombre): cada captura
// nueva refresca el envelope real que se reenvia al gateway.
function newestFixture() {
	const files = fs.readdirSync(FIXTURES_DIR)
		.filter((f) => f.startsWith("capture-ws-") && f.endsWith(".json"))
		.sort();
	if (!files.length) throw new Error("sin fixtures en engine/fixtures/");
	return path.join(FIXTURES_DIR, files[files.length - 1]);
}

function loadTemplate() {
	const fixture = JSON.parse(fs.readFileSync(newestFixture(), "utf8"));
	const dataFrame = fixture.frames
		.map((f) => Buffer.from(f.data, "base64"))
		.find((b) => b[0] === FRAME.DATA && b[7] === FRAME.FLAG_CLIENT);
	if (!dataFrame) throw new Error("fixture sin frame de envio");
	const sent = JSON.parse(dataFrame.subarray(8).toString("utf8"));
	return { reqId: sent["req-id"], payload: decodePb(Buffer.from(sent.payload, "base64")) };
}

// ---------- slots ----------

// Localiza un nodo por ruta de fields: [2,1,2,1] -> f2.f1.f2.f1
function leafAt(nodes, path) {
	let list = nodes;
	for (let i = 0; i < path.length; i++) {
		const f = path[i];
		const hit = list.find((n) => n.field === f && (i === path.length - 1 || n.kind === "pb"));
		if (!hit) return null;
		if (i === path.length - 1) return hit;
		list = hit.pb;
	}
	return null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const appSessionId = () =>
	Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")).join("-");

// Sustituye slots por RUTA (estructural), para que el template pueda ser
// cualquier captura y no dependa de valores hardcodeados.
// replaced == 0 => drift de protocolo: mejor fallar que mandar pbs corruptos.
export function insertSlots(nodes, {
	prompt, conversationId, turnId, reqId, userId, now = Date.now(),
}) {
	let replaced = 0;

	// 1) ids del template (para replace global por valor)
	const convOld = leafAt(nodes, [2, 1, 2, 1])?.str ?? null;
	const turnOld = leafAt(nodes, [2, 1, 1])?.str ?? null;
	const reqOld = leafAt(nodes, [1, 6])?.str ?? null;

	const replaceIn = (list) => {
		for (const n of list) {
			if (n.wire !== 2) continue;
			if (n.kind === "str") {
				let s = n.str;
				if (convOld && s.includes(convOld)) s = s.split(convOld).join(conversationId);
				if (turnOld && s.includes(turnOld)) s = s.split(turnOld).join(turnId);
				if (reqOld && s.includes(reqOld)) s = s.split(reqOld).join(reqId);
				if (s !== n.str) { n.str = s; replaced++; }
			} else if (n.kind === "pb") {
				replaceIn(n.pb);
			}
		}
	};
	replaceIn(nodes);

	// 2) slots por ruta
	const promptLeaf = leafAt(nodes, [2, 2]);
	if (!promptLeaf || promptLeaf.kind !== "str") throw new Error("template: sin slot de prompt (f2.2)");
	promptLeaf.str = prompt;
	replaced++;

	const turnLeaf = leafAt(nodes, [2, 1, 1]);
	if (turnLeaf?.kind === "str") { turnLeaf.str = turnId; replaced++; }

	const convLeaf = leafAt(nodes, [2, 1, 2, 1]);
	if (convLeaf?.kind === "str") { convLeaf.str = conversationId; replaced++; }

	const reqLeaf = leafAt(nodes, [1, 6]);
	if (reqLeaf?.kind === "str") { reqLeaf.str = reqId; replaced++; }

	// 3) timestamps (epoch ms)
	for (const [p, delta] of [[[1, 5, 1], 0], [[1, 5, 3], -1000], [[2, 1, 2, 2], 0]]) {
		const leaf = leafAt(nodes, p);
		if (leaf && leaf.wire === 0) { leaf.varint = BigInt(now + delta); replaced++; }
	}

	// 4) flow ids por request (el browser los regenera en cada envio)
	for (const p of [[1, 10, 1], [1, 10, 3]]) {
		const leaf = leafAt(nodes, p);
		if (leaf?.kind === "str" && UUID_RE.test(leaf.str)) { leaf.str = randomUUID(); replaced++; }
	}

	// 5) id de usuario (solo si el caller lo conoce y el template trae el del captura)
	if (userId) {
		for (const p of [[1, 1, 8, 1], [1, 1, 8, 2]]) {
			const leaf = leafAt(nodes, p);
			if (leaf?.kind === "str") { leaf.str = userId; replaced++; }
		}
		// accountId del contexto de usuario (bigint) — sin esto, un invitado
		// arrastraría el id de la cuenta con la que se capturó el template
		for (const p of [[1, 2, 1], [1, 2, 2]]) {
			const leaf = leafAt(nodes, p);
			if (leaf && leaf.wire === 0) { leaf.varint = BigInt(userId); replaced++; }
		}
	}

	return { replaced };
}

export function buildRequestPayload({
	prompt, conversationId, turnId = randomUUID(), reqId = randomUUID(), userId, now = Date.now(),
}) {
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
	const { replaced } = insertSlots(nodes, { prompt, conversationId, turnId, reqId, userId, now });
	return { payload: encodePb(nodes), replaced, reqId };
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
	constructor({
		token, userId, cookies, conversationId = randomUUID(), pingMs = PING_INTERVAL_MS, debug = false,
	}) {
		if (!token) throw new TypeError("MetaGateway: falta token ecto1:");
		// el accessToken de meta ya viene como "ecto1:..."; se acepta ambas formas
		this.token = token.startsWith("ecto1:") ? token : `ecto1:${token}`;
		this.userId = userId;
		this.cookies = cookies ?? null; // string "k=v; k2=v2" o null
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
			"Authorization": this.token,
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
			w.res(d);
		}
	}

	#readFrame() {
		if (this.#q.length) return Promise.resolve(this.#q.shift());
		return new Promise((res, rej) => { this.#waiting = { res, rej }; });
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
		this.#log("cerrado", code, this.#closed.reason);
		const rej = this.#openRej; this.#openRej = null; this.#openRes = null;
		rej?.(new GatewayError(code, this.#closed.reason || "cerrado"));
		// una lectura de frame pendiente debe morir con el socket, no colgarse
		const waiting = this.#waiting; this.#waiting = null;
		waiting?.rej?.(new GatewayError(code, this.#closed.reason || "cerrado"));
	}

	async connect({ timeoutMs = 20000 } = {}) {
		const url = this.url();
		this.#log("conectando", url.replace(this.token, "REDACTED"));
		const headers = {
			// el gateway valida el Origin en el pre-auth: debe ser la URL completa
			Origin: `https://${PROTOCOL.ORIGIN}`,
			"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
		};
		if (this.cookies) headers.Cookie = this.cookies;
		// el promise se arma ANTES de construir el socket: si el upgrade falla,
		// el evento 'error' llega antes de existir el await y se perdia.
		const opened = new Promise((res, rej) => { this.#openRes = res; this.#openRej = rej; });
		let ws;
		try {
			ws = this.ws = new WS(url, { headers });
		} catch (err) {
			throw new GatewayError(CLOSE.ABNORMAL, `upgrade fallo: ${err.message}`);
		}
		ws.binaryType = "arraybuffer";
		ws.on("open", () => this.#onOpen());
		ws.on("message", (data) => this.#onData(Buffer.from(data)));
		ws.on("error", (err) => this.#onError(err));
		ws.on("close", (code, reason) => this.#onClose(code, reason?.toString?.() ?? ""));
		const timer = setTimeout(() => {
			const rej = this.#openRej; this.#openRej = null; this.#openRes = null;
			rej?.(new GatewayError(CLOSE.ABNORMAL, `timeout de conexion (${timeoutMs}ms)`));
			try { ws.close(); } catch { /* ignore */ }
		}, timeoutMs);
		try {
			await opened;
		} finally {
			clearTimeout(timer);
		}
		ws.send(new Uint8Array(buildFrame(FRAME.HANDSHAKE, JSON.stringify({
			"x-dgw-app-x-ecto-conversation-id": this.conversationId,
			"x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
		}))));
		// el handshake puede venir despues de keepalives: se salta hasta verlo
		let hs = null;
		for (;;) {
			const fr = await this.#readFrame();
			if (fr.error) throw fr.error;
			if (fr.keepalive) { this.#log("keepalive antes del handshake", "0x" + fr.type.toString(16)); continue; }
			hs = fr;
			break;
		}
		if (hs.type !== FRAME.HANDSHAKE) throw new GatewayError(CLOSE.BAD_REQUEST, `handshake: tipo 0x${hs.type?.toString(16)}`);
		const code = JSON.parse(hs.payload.toString("utf8")).code;
		if (code !== 200) throw new GatewayError(CLOSE.UNAUTHORIZED, `handshake code ${code}`);
		this.#pingTimer = setInterval(() => {
			if (ws.readyState === 1) ws.send(new Uint8Array(FRAME.PING));
		}, this.pingMs);
		return { conversationId: this.conversationId };
	}

	#onOpen() {
		const res = this.#openRes; this.#openRes = null; this.#openRej = null;
		res?.();
	}

	// Envia un prompt y acumula el stream. onText(textoAcumulado) opcional.
	// Resuelve al llegar patch vacio; luego close o seguir listo con el mismo ws.
	async chat(prompt, { onText } = {}) {
		if (!this.ws || this.ws.readyState !== 1 || this.#closed)
			throw new Error("chat: gateway no conectado");
		const reqId = randomUUID();
		const { payload, replaced } = buildRequestPayload({
			prompt,
			conversationId: this.conversationId,
			reqId,
			userId: this.userId,
		});
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
