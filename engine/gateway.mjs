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
	decodePb, encodePb, extractJsons, parseFrames,
} from "./pb.mjs";
import { imagesOfJson } from "./media.mjs";
import { evento } from "./eventos.mjs";

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

// Snowflake de meta (mismo formato que el uniqueMessageId real):
// (Date.now() en ms << 22) | bits aleatorios. OJO: si se repite, el gateway
// lo toma como el MISMO mensaje y devuelve la respuesta anterior.
export function newUniqueMessageId() {
	const ms = BigInt(Date.now());
	const rand22 = BigInt(Math.floor(Math.random() * 0x400000));
	return (ms << 22n) | rand22;
}

const appSessionId = () =>
	Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")).join("-");

// Sustituye slots por RUTA (estructural), para que el template pueda ser
// cualquier captura y no dependa de valores hardcodeados.
// replaced == 0 => drift de protocolo: mejor fallar que mandar pbs corruptos.
export function insertSlots(nodes, {
	prompt, conversationId, turnId, reqId, userId, now = Date.now(), sessionTs = null, depth = null, attachments = [],
	replyTo = null, messageIndex = null, firstMessage = true,
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

	// 3) timestamps (epoch ms).
	//    f1.5.1 / f1.5.3 = timestamps de INICIO de la sesion/stream: deben
	//    quedar CONSTANTES durante el hilo (si se refrescan en cada mensaje, el
	//    servidor espera el stream anterior y no responde: se queda mudo).
	//    f2.1.2.2 = timestamp del mensaje: ese si avanza.
	const sStart = sessionTs?.start ?? now;
	const sEnd = sessionTs?.end ?? now - 1000;
	for (const [p, value] of [[[1, 5, 1], sStart], [[1, 5, 3], sEnd], [[2, 1, 2, 2], now]]) {
		const leaf = leafAt(nodes, p);
		if (leaf && leaf.wire === 0) { leaf.varint = BigInt(value); replaced++; }
	}

	// 3b) uniqueMessageId (f2.1.2.3): IDENTIFICADOR DEL MENSAJE. Si se repite,
	// el gateway responde con la respuesta del mensaje anterior.
	const uniqueLeaf = leafAt(nodes, [2, 1, 2, 3]);
	if (uniqueLeaf && uniqueLeaf.wire === 0) {
		uniqueLeaf.varint = newUniqueMessageId();
		replaced++;
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

	// 6) PUNTERO DE HILO (verificado contra el navegador, captura pair2 del
	//    2026-11-01 con dos mensajes en el MISMO chat):
	//      f2.1.4 = response_id de la respuesta ANTERIOR ("e.xxxx"). Es lo que
	//               ata el mensaje a SU conversacion. SIN esto el servidor usa
	//               el contexto "activo" de la cuenta y los hilos se cruzan.
	//      f2.1.5 = flag de PRIMER mensaje (varint 1). Solo va en el primero.
	//      f2.4.1 = indice del mensaje en el hilo ("0", "2", "4", ...).
	//      f1.1.12.4 = flag de primer mensaje. Solo va en el primero.
	//      f1.1.1 = superficie de la UI: HOME en el primero, CHAT despues.
	const msgNode = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
	const inner = msgNode?.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "pb");
	if (!inner) throw new Error("template: sin mensaje interno (f2.1)");

	if (messageIndex !== null) {
		const leaf = leafAt(nodes, [2, 4, 1]);
		if (leaf?.kind === "str") { leaf.str = String(messageIndex); replaced++; }
	}

	const surface = leafAt(nodes, [1, 1, 1]);
	if (surface?.kind === "str" && /KADABRA__(HOME|CHAT)__/.test(surface.str)) {
		surface.str = firstMessage ? "KADABRA__HOME__UNIFIED_INPUT_BAR" : "KADABRA__CHAT__UNIFIED_INPUT_BAR";
		replaced++;
	}

	if (firstMessage) {
		const leaf = leafAt(nodes, [2, 1, 5]);
		if (leaf && leaf.wire === 0) { leaf.varint = 1n; replaced++; }
	} else {
		// los flags de "primer mensaje" se OMITEN (asi lo hace el front)
		const i5 = inner.pb.findIndex((n) => n.field === 5);
		if (i5 >= 0) { inner.pb.splice(i5, 1); replaced++; }
		const ux = leafAt(nodes, [1, 1, 12]);
		if (ux?.kind === "pb") {
			const i4 = ux.pb.findIndex((n) => n.field === 4);
			if (i4 >= 0) { ux.pb.splice(i4, 1); replaced++; }
		}
	}

	// f2.1.4 = id de la respuesta anterior: el eslabon del hilo.
	if (replyTo) {
		const hit = inner.pb.find((n) => n.field === 4);
		if (hit) {
			hit.wire = 2; hit.kind = "str"; hit.str = replyTo;
			delete hit.pb; delete hit.bytes; delete hit.varint;
		} else {
			inner.pb.push({ field: 4, wire: 2, kind: "str", str: replyTo });
		}
		replaced++;
	}

	// 7) adjuntos (f2.3): cada adjunto es un submensaje con
	//    f1.1 = media_id (bigint), f2 = 1, f5 = 0, f6 = mime, f7 = nombre.
	//    El prompt lleva el marcador <|attachment:N|> delante del texto.
	if (attachments.length) {
		const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
		if (!msg) throw new Error("template: sin mensaje (f2) para adjuntar");
		for (const a of attachments) {
			msg.pb.push({
				field: 3, wire: 2, kind: "pb",
				pb: [
					{ field: 1, wire: 2, kind: "pb", pb: [{ field: 1, wire: 0, varint: BigInt(a.mediaId) }] },
					{ field: 2, wire: 0, varint: 1n },
					{ field: 5, wire: 0, varint: 0n },
					{ field: 6, wire: 2, kind: "str", str: a.mime ?? "application/octet-stream" },
					{ field: 7, wire: 2, kind: "str", str: a.filename ?? "archivo" },
				],
			});
			replaced++;
		}
		const markers = attachments.map((_, i) => `<|attachment:${i}|>`).join(" ");
		promptLeaf.str = `${markers} ${promptLeaf.str}`;
	}

	return { replaced };
}

export function buildRequestPayload({
	prompt, conversationId, turnId = randomUUID(), reqId = randomUUID(), userId, now = Date.now(), sessionTs = null, depth = null, attachments = [],
	replyTo = null, messageIndex = null, firstMessage = true,
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
	const { replaced } = insertSlots(nodes, { prompt, conversationId, turnId, reqId, userId, now, sessionTs, depth, attachments, replyTo, messageIndex, firstMessage });
	return { payload: encodePb(nodes), replaced, reqId };
}

// ---------- cliente ----------

// Aplica una operacion del patch sobre el objeto response acumulado.
// Path estilo JSON pointer: "/sections/0/view_model/primitive/text"
function applyOperation(root, op) {
	if (!root || !op || typeof op.path !== "string") return;
	const parts = op.path.split("/").slice(1)
		.map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
	let cur = root;
	for (let i = 0; i < parts.length - 1; i++) {
		if (cur == null) return;
		cur = cur[parts[i]];
	}
	if (cur == null) return;
	const last = parts[parts.length - 1];
	if (last === undefined) return;
	switch (op.op) {
		case "delta":
		case "append":
			cur[last] = (cur[last] ?? "") + (op.value ?? "");
			break;
		case "replace":
			cur[last] = op.value;
			break;
		case "remove":
			delete cur[last];
			break;
		default:
			cur[last] = op.value;
	}
}

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
		// timestamps de inicio de sesion/stream: CONSTANTES durante el hilo
		this.sessionTs = { start: Date.now(), end: Date.now() - 1000 };
		// profundidad del hilo: cuantos mensajes lleva esta conversacion
		this.depth = 0;
		// puntero de hilo: response_id de la respuesta anterior (f2.1.4) e
		// indice del mensaje (f2.4.1). Se persisten fuera de la conexion.
		this.replyTo = null;
		this.messageIndex = 0;
		this.pingMs = pingMs;
		this.debug = debug;
		this.ws = null;
		this.#q = [];
		this.#waiting = null;
		this.#lastRid = null; // response_id del turno anterior (para descartar colas)
	}

	#q;
	#waiting;
	#lastRid = null;
	#buf = Buffer.alloc(0); // bytes pendientes de frames DGW
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
		if (data.length === 1) {
			// keepalive: llega como mensaje WS de 1 byte
			this.#q.push({ keepalive: true, type: data[0] });
			this.#flush();
			return;
		}
		// Los frames DGW pueden llegar PARTIDOS entre mensajes WS y/o varios
		// concatenados en uno: se acumula y se extrae frame a frame.
		this.#buf = this.#buf.length ? Buffer.concat([this.#buf, data]) : data;
		for (;;) {
			if (this.#buf.length < 6) break;
			const len = this.#buf.readUInt16LE(3);
			const total = 6 + len;
			if (this.#buf.length < total) break; // frame incompleto: esperar mas bytes
			try {
				this.#q.push(parseFrame(this.#buf.subarray(0, total)));
			} catch (err) {
				this.#q.push({ error: err });
			}
			this.#buf = this.#buf.subarray(total);
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
		// el token viaja url-encoded en la query: hay que ocultar las dos formas
		this.#log("conectando", url
			.replace(this.token, "REDACTED")
			.replace(encodeURIComponent(this.token), "REDACTED")
			.replace(/ecto1(?::|%3A)[A-Za-z0-9_-]{16,}/g, "ecto1:REDACTED"));
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
	// onJson(json) recibe cada JSON crudo del stream (diagnostico: imagenes,
	// tarjetas, adjuntos generados). Resuelve al llegar patch vacio; luego
	// close o seguir listo con el mismo ws.
	async chat(prompt, { onText, onJson, onCrudo, attachments = [], watchdogMs = 0, watchdogPrompt = "continua", onWatchdog = null, ...opts } = {}) {
		if (!this.ws || this.ws.readyState !== 1 || this.#closed)
			throw new Error("chat: gateway no conectado");
		const reqId = randomUUID();
		const firstMessage = this.messageIndex === 0;
		// el watchdog reenvia "continua" en el MISMO hilo: mismo puntero, mismo
		// indice (el turno no avanza hasta que termina bien).
		const enviar = (texto, { conAdjuntos = false } = {}) => {
			const id = randomUUID(); // el "req-id" del wrapper DEBE ser el f1.6 del pb
			const { payload, replaced } = buildRequestPayload({
				prompt: texto,
				conversationId: this.conversationId,
				reqId: id,
				userId: this.userId,
				sessionTs: this.sessionTs,
				depth: this.depth + 1,
				attachments: conAdjuntos ? attachments : [],
				replyTo: this.replyTo,
				messageIndex: this.messageIndex,
				firstMessage,
			});
			if (replaced < 2) throw new Error(`template: ${replaced} slots — drift de protocolo probable`);
			this.ws.send(new Uint8Array(buildFrame(FRAME.DATA,
				JSON.stringify({ "req-id": id, payload: payload.toString("base64") }),
				FRAME.FLAG_CLIENT)));
		};
		enviar(prompt, { conAdjuntos: true });
		this.depth += 1;

		// cola del turno anterior: se descarta (el frame de "estado final" de la
		// respuesta previa llega despues del patch vacio y contamina el turno nuevo)
		this.#q.length = 0;

		let acc = null;      // response con TEXTO del turno en curso
		let curRid = null;   // response_id del turno en curso
		const imgs = new Map(); // imagenes generadas (dedupe por url)
		let sawText = false; // ya hubo texto de este turno
		let sawCodigo = false; // hubo una tool call (codigo): es contenido real
		let sawPensando = false; // meta esta "pensando": NO es contenido
		let nudged = false;  // ya se le mando el "continua"
		let lastProgressAt = Date.now();
		let lastContentAt = Date.now(); // ultimo frame con CONTENIDO (texto/codigo)
		const idleMs = opts.idleMs ?? 120_000;
		// Ventana de gracia: el patch VACIO es un LATIDO de meta, no el fin del
		// turno (medido 2026-11-08). Cuando el texto acumulado esta truncado se
		// espera ese frame "final" (estado completo) en vez de devolver la
		// respuesta cortada. Tope: graceFinalMs (0 = desactivado).
		const graceMs = Number.isFinite(Number(opts.graceFinalMs))
			? Math.max(0, Number(opts.graceFinalMs))
			: 4000;
		let graceUntil = 0; // 0 = ventana de gracia cerrada
		// El modelo sigue generando: la ventana se RENUEVA (el corte se mide
		// en silencio, no en total). El tope duro del turno (deadlineAt) acota
		// la espera total.
		const renovarGracia = () => {
			if (graceUntil) graceUntil = Date.now() + graceMs;
		};
		// Tope duro del turno: sin esto, un turno mudo puede quedarse esperando
		// el idle completo y multiplicado por los reintentos del broker.
		const deadlineMs = opts.deadlineMs ?? 0;
		const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : 0;
		for (;;) {
			const restante = deadlineAt ? Math.max(0, deadlineAt - Date.now()) : idleMs;
			let espera = Math.min(idleMs, restante || idleMs);
			// Con watchdog se despierta ANTES de que se dispare, para poder
			// empujar a meta a tiempo (si no, el nudge nunca llega: solo se
			// evaluaba cuando entraba un frame, y en un turno "pensando" no
			// entra ninguno).
			if (watchdogMs > 0 && !nudged) {
				const hastaWatchdog = lastContentAt + watchdogMs - Date.now();
				if (hastaWatchdog > 0) espera = Math.min(espera, hastaWatchdog);
			}
			// Con la ventana de gracia abierta, la espera NUNCA pasa del tiempo
			// que queda: si el frame final no llega, se cierra con lo acumulado.
			if (graceUntil) {
				const queda = graceUntil - Date.now();
				if (queda <= 0) {
					this.#log("ventana de gracia agotada: se cierra con lo acumulado");
					this.#lastRid = curRid;
					return this.#finish(acc, reqId, curRid, [...imgs.values()]);
				}
				espera = Math.min(espera, queda);
			}
			// El temporizador se limpia en cuanto llega un frame: si no, cada
			// lectura deja un setTimeout vivo (hasta idleMs) y el proceso se
			// queda despierto sin motivo.
			let temporizador = null;
			const fr = await Promise.race([
				this.#readFrame(),
				new Promise((res) => { temporizador = setTimeout(() => res({ idle: true }), espera); }),
			]);
			if (temporizador) clearTimeout(temporizador);
			if (fr.idle) {
				// La ventana de gracia NO es un error: se cierra el turno con lo
				// acumulado (lo que ya llego no se pierde nunca).
				if (graceUntil) {
					if (Date.now() >= graceUntil) {
						this.#lastRid = curRid;
						return this.#finish(acc, reqId, curRid, [...imgs.values()]);
					}
					continue; // la ventana sigue viva: se espera un poco mas
				}
				// watchdog: meta se quedo mudo (o pensando) -> "continua" en el
				// MISMO hilo, como hace el usuario en la web.
				if (watchdogMs > 0 && !nudged && Date.now() - lastContentAt > watchdogMs) {
					nudged = true;
					this.#log("watchdog: meta mudo, se envia", watchdogPrompt);
					onWatchdog?.({ ms: Date.now() - lastContentAt });
					try { enviar(watchdogPrompt); } catch (err) { this.#log("watchdog: envio fallo", err?.message); }
					continue; // el turno sigue vivo: se espera la respuesta
				}
				if (deadlineAt && Date.now() >= deadlineAt) {
					throw new GatewayError(CLOSE.KEEPALIVE_TIMEOUT,
						`turno sin respuesta completa en ${deadlineMs}ms${sawPensando ? " (meta se quedo pensando)" : ""}`);
				}
				throw new GatewayError(CLOSE.KEEPALIVE_TIMEOUT,
					`stream sin frames por ${espera}ms${sawPensando ? " (meta se quedo pensando)" : ""}`);
			}
			// watchdog: meta se quedo mudo (defecto conocido, tambien en la web).
			// se le reenvia "continua" en el MISMO hilo, como hace el usuario.
			if (watchdogMs > 0 && !nudged && Date.now() - lastContentAt > watchdogMs) {
				nudged = true;
				this.#log("watchdog: meta mudo, se envia", watchdogPrompt);
				onWatchdog?.({ ms: Date.now() - lastContentAt });
				try { enviar(watchdogPrompt); } catch (err) { this.#log("watchdog: envio fallo", err?.message); }
			}
			if (this.#closed) throw new GatewayError(this.#closed.code, this.#closed.reason || "cerrado en stream");
			if (fr.error) throw fr.error;
			if (fr.keepalive) continue;
			if (fr.type === FRAME.ACK || fr.type === FRAME.HANDSHAKE) continue;
			if (fr.type !== FRAME.DATA) { this.#log("frame no manejado", fr); continue; }

			for (const j of extractJsons(fr.payload)) {
				onJson?.(j);
				onCrudo?.(j); // diagnostico: TODOS los frames, incluso los previos
				lastProgressAt = Date.now();
				if (this.debug) {
					// traza de frames: sirve para ver por que un turno no cierra
					const n = Array.isArray(j.sections) ? j.sections.length : 0;
					const ops = Array.isArray(j.operations) ? j.operations.length : -1;
					evento("WS_FRAME", {
						type: j.type ?? "(final)", rid: j.response_id ?? j.response?.response_id ?? "-",
						secciones: n, ops, chars: textOf(j.response ?? j)?.length ?? 0,
					});
				}
				for (const im of imagesOfJson(j)) imgs.set(im.key ?? im.url, im);
				const rid = j.response_id ?? j.response?.response_id ?? null;
				const isFull = j.type === "full" && !!j.response;
				const isPatch = j.type === "patch";
				// Frame FINAL: JSON con response_id + sections y SIN "type".
				// Es el estado completo de la respuesta y el cierre del turno.
				const isFinal = !j.type && !!j.sections && !!rid;

				if (isFinal) {
					// estado final: se adopta y cierra el turno
					if (rid === this.#lastRid) continue;
					const r = j;
					const t = textOf(r);
					// Gana el texto MAS LARGO: el frame final trae el estado completo,
					// pero si vierte menos que lo ya acumulado se conserva lo
					// acumulado (nunca se pierde contenido).
					const previo = textOf(acc) ?? "";
					if (t !== null && t.length >= previo.length) {
						acc = r;
						sawText = true;
						lastContentAt = Date.now();
						onText?.(t);
					} else if (t !== null) {
						this.#log("final mas corto que lo acumulado: se conserva lo acumulado");
						lastContentAt = Date.now();
					}
					this.#lastRid = rid ?? curRid;
					return this.#finish(acc, reqId, rid ?? curRid, [...imgs.values()]);
				}

				if (isFull) {
					if (rid) {
						if (rid === this.#lastRid) continue; // cola de la respuesta anterior
						if (!curRid) curRid = rid;
						else if (rid !== curRid) {
							// rid distinto: o es la respuesta nueva (si aun no hay
							// texto) o es cola de la respuesta anterior (se ignora)
							if (sawText) continue;
							curRid = rid;
							acc = null;
						}
					}
					const r = j.response ?? j;
					const t = textOf(r);
					if (t === null) {
						// Sin texto. Puede ser (a) una tool call: el CODIGO es el
						// contenido -> turno valido; o (b) el estado "pensando" de
						// meta (GenAIBotThinkingStatusPrimitive): NO es contenido.
						// (medido 2026-11-01: contar el "pensando" como contenido
						// hacia que el patch vacio cerrara el turno y devolviéramos
						// una respuesta VACIA -> "Compaction produced no summary")
						if (tieneCodigo(r)) {
							acc = r; sawCodigo = true;
							lastContentAt = Date.now();
							renovarGracia();
							if (rid && !curRid) curRid = rid;
						} else if (Array.isArray(r?.sections) && r.sections.length) {
							sawPensando = true;
							const prim = r.sections[0]?.view_model?.primitive ?? {};
							this.#log("pensando:", prim.title ?? prim.__typename ?? "?");
						}
						continue; // status ("pensando"), no es respuesta
					}
					const prev = textOf(acc) ?? "";
					if (!acc || t.length >= prev.length) {
						acc = r;
						sawText = true;
						lastContentAt = Date.now();
						renovarGracia();
						onText?.(t);
					}
				} else if (isPatch) {
					const ops = j.operations ?? [];
					if (ops.length === 0) {
						// Parche vacio: LATIDO de meta (meta lo manda cuando no hay
						// cambios). NO es el fin del turno: medido el 2026-11-08 el
						// latido cae EN MEDIO del texto y el frame "final" con el
						// texto COMPLETO llega ~1.4 s despues. Cerrar aqui devolvia
						// la respuesta cortada (y el frame final se descartaba luego
						// como cola del turno anterior).
						//
						// Si ya hay contenido (texto o tool call):
						//   - texto truncado -> se abre la ventana de gracia y se sigue
						//     leyendo hasta el frame final;
						//   - texto completo  -> se cierra el turno (sin latencia).
						if (sawText || sawCodigo) {
							if (graceUntil) {
								// ventana abierta: el latido no cierra nada
								if (Date.now() >= graceUntil) {
									this.#lastRid = curRid;
									return this.#finish(acc, reqId, curRid, [...imgs.values()]);
								}
								continue;
							}
							const texto = textOf(acc) ?? "";
							// Un latido NO cierra el turno si el texto esta a medio
							// camino: estructuralmente (JSON/codigo) o en prosa
							// (etiqueta, titulo o item de lista sin contenido).
							const finEstructural = textoTruncado(texto);
							const finEnProsa = textoInacabado(texto);
							if (graceMs > 0 && (finEstructural || finEnProsa)) {
								graceUntil = Date.now() + graceMs;
								this.#log(
									"latido con texto a medio camino: se espera el frame final",
									graceMs,
									finEstructural ? "estructural" : "prosa",
								);
								continue; // NO se cierra el turno
							}
							this.#lastRid = curRid;
							return this.#finish(acc, reqId, curRid, [...imgs.values()]);
						}
						continue;
					}
					if (!acc) continue; // delta sin full previo: no hay a que aplicar
					for (const op of ops) applyOperation(acc, op);
					const t = textOf(acc);
					if (t !== null) {
						sawText = true;
						lastContentAt = Date.now();
						renovarGracia();
						onText?.(t);
					} else if (tieneCodigo(acc)) {
						// la tool call puede llegar por parche: tambien es contenido
						sawCodigo = true;
						lastContentAt = Date.now();
						renovarGracia();
					}
				}
			}
		}
	}

	// Cierra el turno y fija el puntero del SIGUIENTE mensaje:
	//   replyTo = response_id de ESTA respuesta (f2.1.4)
	//   messageIndex += 2 (un mensaje de usuario + uno del asistente)
	// Si el turno falla no se llama: el hilo no avanza.
	//
	// EXCEPTO cuando el turno vino VACIO (sin texto y sin bloque de codigo):
	// medido el 2026-11-01, un turno vacio deja el hilo MUERTO: todas las
	// peticiones siguientes (con reply_to = response_id de ese turno) se
	// quedan sin respuesta hasta que caduca. Con un turno vacio el puntero
	// NO avanza: se sigue apuntando al ultimo turno con contenido real.
	#finish(acc, reqId, responseId, images = []) {
		const texto = textOf(acc);
		const conCodigo = tieneCodigo(acc);
		const vacio = !texto && !conCodigo;
		if (vacio) {
			this.turnoVacio = (this.turnoVacio ?? 0) + 1;
			return { text: texto, reqId, responseId: responseId ?? null, images, response: acc, vacio: true };
		}
		this.turnoVacio = 0;
		if (responseId) this.replyTo = responseId;
		this.messageIndex += 2;
		return { text: texto, reqId, responseId: responseId ?? null, images, response: acc, vacio: false };
	}
	close() {
		clearInterval(this.#pingTimer);
		try { this.ws?.close(1000); } catch {}
	}

	/** el socket sigue abierto y usable? */
	isClosed() {
		return !this.ws || this.ws.readyState !== 1 || !!this.#closed;
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

/**
 * ¿El texto esta estructuralmente INCOMPLETO?
 *
 * POR QUE EXISTE (medido el 2026-11-08): el texto de una respuesta llega
 * troceado en parches "delta" y el patch VACIO es un LATIDO de meta, no el
 * fin del turno. El frame "final" (estado completo de la respuesta) puede
 * llegar mas tarde. Si el texto acumulado esta a medio camino (llaves sin
 * cerrar, cadena sin terminar, bloque de codigo sin cerrar) hay que ESPERAR
 * ese frame final en vez de devolver la mitad de la respuesta.
 *
 * Es heuristico y NUNCA lanza: ante cualquier duda devuelve false (no
 * truncado) para no meter latencia extra en una respuesta normal.
 *
 * @param {string} texto
 * @returns {boolean}
 */
export function textoTruncado(texto) {
	try {
		if (typeof texto !== "string" || texto.length === 0) return false;
		const pila = [];   // llaves/cerillas abiertas
		let cadena = null; // delimitador de la cadena abierta
		let escapado = false;
		let cerca = null;  // delimitador del bloque de codigo abierto (``` o ~~~)
		let i = 0;
		const n = texto.length;
		while (i < n) {
			const c = texto[i];
			// --- bloque de codigo (``` o ~~~) ---
			if (cadena === null && (c === "`" || c === "~")) {
				let j = i;
				while (j < n && texto[j] === c) j++;
				const racha = j - i;
				const inicioLinea = i === 0 || texto[i - 1] === "\n";
				if (cerca) {
					// dentro del bloque: solo el cierre del mismo marca cuenta
					if (c === cerca && racha >= 3) { cerca = null; i = j; continue; }
					i = j; continue;
				}
				if (racha >= 3 && inicioLinea) { cerca = c; i = j; continue; }
				if (racha === 1 && c === "`") { cadena = c; i = j; continue; }
				i = j; continue;
			}
			// --- dentro de una cadena: solo importa su cierre ---
			if (cadena !== null) {
				if (escapado) { escapado = false; i++; continue; }
				if (c === "\\") { escapado = true; i++; continue; }
				if (c === cadena) cadena = null;
				i++;
				continue;
			}
			// --- apertura de cadena ---
			if (!cerca && (c === '"' || c === "'" || c === "`")) {
				// el apostrofo pegado a una letra es una CONTRACCION, no una
				// cadena ("don't"): solo abre cadena si no precede a un alfanumerico
				if (c === "'" && i > 0 && /[\p{L}\p{N}]/u.test(texto[i - 1])) { i++; continue; }
				cadena = c; i++;
				continue;
			}
			// --- llaves y cerillas ---
			if (c === "{" || c === "[") { pila.push(c); i++; continue; }
			if (c === "}" || c === "]") {
				const tope = pila.pop();
				// un cierre sin apertura es ruido; un cierre CRUZADO deja una
				// apertura sin cerrar -> texto truncado
				if (tope !== undefined && tope !== (c === "}" ? "{" : "[")) return true;
				i++;
				continue;
			}
			i++;
		}
		return cerca !== null || cadena !== null || pila.length > 0;
	} catch {
		return false; // nunca revienta: la duda se resuelve como "no truncado"
	}
}

/**
 * Heuristica de PROSA a medio camino: el texto termina ANUNCIANDO algo que
 * nunca llega (una etiqueta, un titulo o un item de lista vacio).
 *
 * POR QUE EXISTE (medido el 2026-11-09): meta interrumpe la generacion en
 * fronteras de estructura y ahi cae el patch VACIO (latido). Un texto como
 * "**2. Lo que te falta:**" NO es JSON truncado, asi que `textoTruncado` no
 * lo veia: el gateway cerraba el turno en el latido y la cola (los bullets
 * que faltaban) se descartaba como "cola del turno anterior". El usuario
 * veia la respuesta cortada justo en el encabezado de la lista.
 *
 * Es heuristico y NUNCA lanza: ante cualquier duda devuelve false (no
 * incompleto) para no meter latencia extra en una respuesta normal.
 *
 * @param {string} texto
 * @returns {boolean}
 */
export function textoInacabado(texto) {
	try {
		if (typeof texto !== "string" || texto.length === 0) return false;
		const t = texto.replace(/\s+$/, "");
		if (!t) return false;
		// Etiqueta markdown cerrada pero sin contenido: "**2. Lo que te falta:**"
		if (/:\*\*$/.test(t)) return true;
		// Negrita abierta (asteriscos impares): "**2. Lo que te falta"
		const negritas = (t.match(/\*\*/g) || []).length;
		if (negritas % 2 === 1) return true;
		// Item de lista vacio en su propia linea: "- " o "1. "
		if (/(?:^|\n)[ \t]*(?:[-*+\u2022]|\d+[.)])[ \t]*$/.test(t)) return true;
		// Titulo markdown al final: "## 2. Resultados" (el cuerpo no llega)
		if (/(?:^|\n)#{1,6}[ \t]+\S[^\n]*$/.test(t)) return true;
		return false;
	} catch {
		return false; // nunca revienta: la duda se resuelve como "completo"
	}
}

// ¿La respuesta trae un bloque de codigo (tool call o archivo)?
// Un turno con tool call tiene el TEXTO vacio: no es un turno vacio.
export function tieneCodigo(response) {
	for (const s of response?.sections ?? []) {
		const prim = s?.view_model?.primitive ?? {};
		if (prim.__typename === "GenAICodeUXPrimitive" && Array.isArray(prim.code_blocks)) {
			const txt = prim.code_blocks.map((b) => b?.content ?? "").join("");
			if (txt.trim()) return true;
		}
	}
	return false;
}
