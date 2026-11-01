// broker-engine.mjs — adaptador del motor protocol-first (gateway DGW) para el
// broker HTTP. Sin navegador en runtime.
//
// Diseño (verificado en vivo contra meta.ai, 2026-11-01):
//   - Cada USUARIO (y canal) tiene su PROPIO chat: un conversation_id
//     persistente por usuario/canal + una conexion WS dedicada.
//   - Antes de abrir el WS: useConversationWarmupMutation + updateConversationMode
//     -> el conversation_id queda atado a un chat real de la cuenta, asi que el
//        hilo conserva memoria entre llamadas y hasta despues de reiniciar el
//        broker (se reanuda con el mismo conversation_id).
//   - Cada mensaje lleva un uniqueMessageId NUEVO (snowflake de meta): si se
//     repite, el gateway responde con la respuesta del mensaje anterior.
//   - Token: por defecto la sesion propia (META_ENGINE_MODE=session). Si caduca,
//     se recaptura del navegador (engine/capture-session.mjs) y el hilo se
//     reanuda con el mismo conversation_id.
//
//   const engine = new MetaEngine({ mode: "session" });
//   await engine.ask("hola", { userId: "u-42", channel: "default", onText });

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MetaGateway, GatewayError, CLOSE } from "./gateway.mjs";
import { MAX_PROMPT_BYTES } from "./pb.mjs";
import { dividirPrompt, piezaDeContexto } from "./partir.mjs";
import { getCredentials, clearCredentials } from "./auth.mjs";
import { MetaGraphQL } from "./meta-graphql.mjs";
import { uploadAll } from "./upload.mjs";
import { downloadImages } from "./media.mjs";
import { extraerCodigo } from "./codigo.mjs";
import { evento } from "./eventos.mjs";
import * as session from "./session.mjs";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, ".conversations.json");
// Registro de salas: id corto (max 6 digitos) -> usuario/canal. Es lo que se
// ve en el titulo del chat de meta, para identificar de un vistazo a que
// usuario pertenece cada canal.
const ROOMS = path.join(HERE, ".rooms.json");
const MAX_ROOM_ID = 999_999;

const DEFAULT_TTL_MS = 45 * 60_000; // conexion sin uso: se cierra (el hilo se reanuda)

function loadStore() {
	try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}
// Guarda SOLO la clave de este canal, releyendo el archivo: si otro proceso
// (p.ej. una emulacion) escribio sus canales, no se pisan entre si.
function saveStoreEntry(key, entry) {
	try {
		const disk = loadStore();
		disk[key] = entry;
		fs.writeFileSync(STORE, JSON.stringify(disk, null, 1), { mode: 0o600 });
		fs.chmodSync(STORE, 0o600);
	} catch { /* el store es opcional */ }
}

function loadRooms() {
	try { return JSON.parse(fs.readFileSync(ROOMS, "utf8")); } catch { return {}; }
}

function saveRooms(rooms) {
	try {
		fs.writeFileSync(ROOMS, JSON.stringify(rooms, null, 1), { mode: 0o600 });
		fs.chmodSync(ROOMS, 0o600);
	} catch { /* el registro es opcional */ }
}

export class MetaEngine {
	// idleMs: cuanto se espera el PRIMER frame de la respuesta. Con varias
	// conversaciones simultaneas, el servidor puede encolar y tardar mas de
	// 120 s -> el cliente abortaba (4001 KEEPALIVE_TIMEOUT) y perdia el turno.
	// Tope duro del turno (deadlineMs): si meta no cierra el turno, se aborta
	// con un error claro en vez de colgar al cliente. Meta responde en 3-6 s
	// normalmente: 45 s de silencio ya es un turno perdido.
	constructor({ mode = "session", idleMs = 45_000, deadlineMs = 75_000, askTimeoutMs = 120_000,
		cdpPort = 9298, debug = false,
		fallbackToGuest = true } = {}) {
		this.mode = mode === "guest" ? "guest" : "session";
		this.idleMs = idleMs;
		this.deadlineMs = deadlineMs;
		// presupuesto total de una peticion (turno + reintentos): el cliente
		// nunca se queda colgado mas de esto.
		this.askTimeoutMs = askTimeoutMs;
		this.cdpPort = cdpPort;
		this.debug = debug;
		// si la sesion propia caduca y no se puede recuperar, se sigue como
		// invitado en vez de dejar la API sin servicio.
		this.fallbackToGuest = fallbackToGuest;
		this.channels = new Map(); // key -> { convId, gw, title, lastUsed }
		this.store = loadStore();
		this.rooms = loadRooms(); // id corto -> { usuario, canal, ... }
		this.creds = null;
		this.gql = null;
		// Estado de autenticacion, expuesto por la API (/health): que identidad
		// esta en uso REALMENTE (invitado o cuenta), y por que.
		this.auth = {
			modoConfigurado: this.mode,
			modo: this.mode,
			userId: null,
			motivo: null,
			desde: new Date().toISOString(),
			caidaAInvitado: false,
		};
	}

	/**
	 * Credenciales actuales (para subir adjuntos a meta). NO se loguean.
	 */
	async credentials() {
		return this.#credentials();
	}

	/**
	 * Que identidad se esta usando ahora: "session" (cuenta) o "guest" (invitado).
	 * El endpoint lo expone para que el cliente sepa si esta talking con la
	 * cuenta del usuario o con un invitado (y por que cambio).
	 */
	authInfo() {
		return {
			...this.auth,
			tieneSesion: !!session.load(),
			sesionCapturable: this.cdpPort != null,
		};
	}

	/**
	 * Id corto de la sala (max 6 digitos) para este usuario/canal. Es el
	 * numero que aparece en el titulo del chat de meta.
	 */
	#roomId(key) {
		const existente = this.rooms[key];
		if (existente?.id) return existente.id;
		const usados = new Set(Object.values(this.rooms).map((r) => r.id));
		let id = 1;
		while (usados.has(id) && id < MAX_ROOM_ID) id++;
		const [usuario, ...resto] = key.split(":");
		this.rooms[key] = {
			id,
			usuario,
			canal: resto.join(":") || "default",
			creada: new Date().toISOString(),
		};
		saveRooms(this.rooms);
		return id;
	}

	/** Registro de salas: id corto -> usuario/canal (para identificarlas). */
	roomsList() {
		return Object.entries(this.rooms)
			.map(([key, r]) => ({ ...r, clave: key }))
			.sort((a, b) => a.id - b.id);
	}

	#channelKey(userId, channel) {
		return `${userId || "anon"}:${channel || "default"}`;
	}

	async #credentials(force = false) {
		if (this.creds && !force) return this.creds;
		if (this.mode === "session") {
			const s = session.load();
			if (!s) {
				// Sin sesion propia: se intenta recuperar del navegador (abre una
				// pestana de meta.ai en el chrome de depuracion y copia SOLO el
				// acceso a meta). Si eso falla, se sigue como invitado.
				const recuperada = await this.#capturarSesion();
				if (recuperada) {
					this.creds = { token: recuperada.token, cookies: recuperada.cookies, userId: recuperada.userId ?? null };
					this.auth = { ...this.auth, modo: "session", userId: recuperada.userId ?? null, motivo: "sesion recuperada del navegador", desde: new Date().toISOString(), caidaAInvitado: false };
				} else if (this.fallbackToGuest) {
					this.creds = await this.#credsInvitado("no hay sesion propia y no se pudo capturar");
					this.gql = new MetaGraphQL(this.creds);
					return this.creds;
				} else {
					throw new Error("sin sesion propia: recaptura con engine/capture-session.mjs (META_ENGINE_MODE=guest para usar invitado)");
				}
			} else {
				this.creds = { token: s.token, cookies: s.cookies, userId: s.userId ?? null };
				this.auth = { ...this.auth, modo: "session", userId: s.userId ?? null, motivo: null, desde: new Date().toISOString(), caidaAInvitado: false };
			}
		} else {
			this.creds = await this.#credsInvitado("modo invitado configurado");
		}
		this.gql = new MetaGraphQL(this.creds);
		return this.creds;
	}

	/** Credenciales de invitado (crea o recicla una) y deja el estado visible. */
	async #credsInvitado(motivo) {
		const c = await getCredentials();
		this.auth = {
			...this.auth,
			modo: "guest",
			userId: c.abraUserId ?? null,
			motivo,
			desde: new Date().toISOString(),
			caidaAInvitado: this.mode === "session",
		};
		evento("AUTH_INVITADO", { motivo, user_id: c.abraUserId ?? null });
		return { token: c.accessToken, cookies: null, userId: c.abraUserId };
	}

	/**
	 * Intenta recuperar la sesion propia del navegador: abre meta.ai en el
	 * chrome de depuracion (o busca uno que ya lo tenga abierto) y copia SOLO
	 * el acceso a meta (token + cookies de meta.ai).
	 */
	async #capturarSesion() {
		try {
			await execFileAsync(process.execPath, [
				path.join(HERE, "capture-session.mjs"), String(this.cdpPort),
			], { timeout: 120_000 });
		} catch (err) {
			this.lastWarn = `captura de sesion fallo: ${err.message}`;
			return null;
		}
		return session.load();
	}

	/** Credencial nueva: invitado nuevo o recaptura de la sesion propia. */
	async #renew() {
		if (this.mode === "session") {
			const s = await this.#capturarSesion();
			if (s) {
				this.creds = null;
				return this.#credentials(true);
			}
			if (!this.fallbackToGuest) throw new Error("no se pudo recapturar la sesion propia");
			// la sesion propia caduco y no se pudo recuperar: se sigue como
			// invitado. Los chats son de otra identidad: se rehacen.
			this.creds = null;
			this.#descartarChats("cambio de identidad a invitado");
			this.auth = { ...this.auth, modo: "guest", motivo: "la sesion propia caduco y no se pudo recapturar", desde: new Date().toISOString(), caidaAInvitado: true };
			return this.#credentials(true);
		}
		clearCredentials();
		this.creds = null;
		return this.#credentials(true);
	}

	/** Cierra las conexiones vivas: el chat pertenece a otra identidad. */
	#descartarChats(motivo) {
		for (const [k, c] of this.channels) {
			try { c.gw.close(); } catch { /* ignore */ }
			this.channels.delete(k);
		}
		evento("AUTH_CAMBIO", { motivo, modo: this.auth.modo });
	}

	/** conversation_id persistente por usuario/canal. */
	#conversationId(key) {
		const entry = this.store[key];
		const modo = this.auth.modo;
		// El chat pertenece a una identidad (cuenta o invitado): si la identidad
		// cambio, el conversation_id viejo no sirve -> chat nuevo para ese
		// usuario/canal (las carpetas por usuario se mantienen igual).
		if (entry?.convId && (entry.auth ?? modo) === modo) return entry.convId;
		const convId = randomUUID();
		const fresh = { convId, title: null, auth: modo, updatedAt: new Date().toISOString() };
		fresh.sala = this.#roomId(key);
		this.store[key] = fresh;
		saveStoreEntry(key, fresh);
		return convId;
	}

	async #open(key) {
		const creds = await this.#credentials();
		const convId = this.#conversationId(key);

		// El warmup es lo que ata el conversation_id a un chat real: sin esto el
		// hilo no conserva memoria (y tras reconectar, tampoco).
		if (this.mode === "session" && this.gql) {
			try {
				await this.gql.warmup(convId);
				await this.gql.setMode(convId, "think_fast");
			} catch (err) {
				// si el warmup falla, el chat puede no quedar atado: se sigue igual
				// (la primera vez responde igual, pero sin memoria persistente)
				this.lastWarn = `warmup fallo: ${err.message}`;
			}
		}

		const gw = new MetaGateway({
			token: creds.token,
			cookies: creds.cookies,
			userId: creds.userId,
			conversationId: convId,
			debug: this.debug,
		});
		// La profundidad del hilo vive FUERA de la conexion: si se reiniciara en
		// 1 al reconectar, el gateway trataria el mensaje como el primero de una
		// conversacion nueva y el hilo perderia la memoria.
		gw.depth = this.store[key]?.depth ?? 0;
		// Puntero de hilo: sin el, al reconectar el servidor usaria el contexto
		// "activo" de la cuenta y los hilos se cruzarian.
		gw.replyTo = this.store[key]?.replyTo ?? null;
		gw.messageIndex = this.store[key]?.messageIndex ?? 0;
		await gw.connect();
		const entry = {
			convId, gw, title: this.store[key]?.title ?? null, depth: gw.depth,
			replyTo: gw.replyTo, messageIndex: gw.messageIndex, lastUsed: Date.now(),
		};
		this.channels.set(key, entry);
		return entry;
	}

	async #conn(key) {
		const now = Date.now();
		for (const [k, c] of this.channels) {
			if (now - c.lastUsed > DEFAULT_TTL_MS && !c.gw.isClosed()) {
				try { c.gw.close(); } catch { /* ignore */ }
				this.channels.delete(k);
			}
		}
		let entry = this.channels.get(key);
		if (entry && !entry.gw.isClosed()) {
			entry.lastUsed = now;
			return entry;
		}
		// habia una conexion (muerta): se reabre. El conversation_id y la
		// profundidad se conservan desde el store, asi que el hilo continua.
		const nuevo = await this.#open(key);
		nuevo.reopened = !!entry;
		return nuevo;
	}

	/**
	 * ask() + reintento con "continua" cuando el turno vuelve VACIO.
	 *
	 * Meta a veces cierra el turno con solo el estado "pensando" (sin texto y
	 * sin codigo): el contenido llega en el turno siguiente y la forma de
	 * pedirlo es "continua" en el MISMO hilo (es el workaround que usa el
	 * usuario en la web). Sin esto, la API responde 200 con content vacio y el
	 * cliente cree que Meta no respondio.
	 *
	 * @param {string} prompt
	 * @param {{maxReintentos?: number, onJson?: (j: any) => void}} opts
	 */
	async askConContenido(prompt, { maxReintentos = 2, ...opts } = {}) {
		const frames = [];
		const onJson = opts.onJson;
		let ultimo = null;
		const t0 = Date.now();
		for (let i = 0; i <= maxReintentos; i++) {
			// presupuesto total: no se reintenta si ya se gasto el tiempo
			const gastado = Date.now() - t0;
			if (i > 0 && gastado >= this.askTimeoutMs) {
				evento("TURNO_CORTADO", {
					usuario: `${opts.userId}:${opts.channel}`, ms: gastado,
					presupuesto: this.askTimeoutMs, intento: i + 1,
				});
				break;
			}
			const r = await this.ask(i === 0 ? prompt : "continua", {
				...opts,
				onJson: (j) => { frames.push(j); onJson?.(j); },
			});
			ultimo = r;
			const texto = String(r.text ?? "").trim();
			const bloques = extraerCodigo(frames, r.response);
			if (texto || bloques.length || (r.images?.length)) {
				return { ...r, intentos: i + 1, bloques, ms: Date.now() - t0 };
			}
			evento("TURNO_VACIO", { usuario: `${opts.userId}:${opts.channel}`, intento: i + 1, ms: Date.now() - t0 });
		}
		return { ...ultimo, intentos: maxReintentos + 1, bloques: [], ms: Date.now() - t0 };
	}

	/**
	 * Envia un mensaje a meta dentro del chat del usuario.
	 * @param {string} prompt
	 * @param {{userId?: string, channel?: string, onText?: (t: string) => void}} opts
	 */
	async ask(prompt, { userId = "anon", channel = "default", onText, onJson, attachments = [],
		watchdogMs = 20_000, watchdogPrompt = "continua" } = {}) {
		const key = this.#channelKey(userId, channel);
		let lastError = null;
		let renewed = false;
		let reconnected = false;
		const t0 = Date.now();
		// El try incluye la APERTURA de la conexion: un fallo de DNS o de
		// upgrade no debe costar el turno (medido: 14 EAI_AGAIN en la emulacion
		// de 1 h, cada uno perdia un turno).
		for (let attempt = 0; attempt < 3; attempt++) {
			let entry = null;
			// presupuesto de la peticion: si ya se gasto, no se reintenta mas
			const restante = this.askTimeoutMs - (Date.now() - t0);
			if (restante <= 0) {
				throw lastError ?? new GatewayError(CLOSE.KEEPALIVE_TIMEOUT, `presupuesto de ${this.askTimeoutMs}ms agotado`);
			}
			try {
				entry = await this.#conn(key);
				return await this.#send(key, entry, prompt, onText, attachments, renewed, reconnected, onJson, watchdogMs, watchdogPrompt, restante);
			} catch (err) {
				lastError = err;
				const authError = err instanceof GatewayError
					&& (err.code === CLOSE.UNAUTHORIZED || err.code === CLOSE.REJECTED);
				// se fuerza la reconexion para el proximo intento
				if (entry) {
					try { entry.gw.close(); } catch { /* ignore */ }
					this.channels.delete(key);
					reconnected = true;
				}
				if (authError && !renewed) {
					// credencial caducada: se renueva y el hilo se reanuda con el
					// MISMO conversation_id (el warmup lo vuelve a atar al chat)
					renewed = true;
					await this.#renew();
					continue;
				}
				if (attempt < 2) {
					await sleep(3000 * (attempt + 1));
					continue;
				}
			}
		}
		throw lastError;
	}

	async #send(key, entry, prompt, onText, attachments = [], renewed = false, reconnect = false, onJson = null,
		watchdogMs = 20_000, watchdogPrompt = "continua", presupuestoMs = null) {
		// los adjuntos se suben ANTES del request: el envelope solo lleva el
		// media_id (f2.3), no los bytes.
		let uploaded = [];
		if (attachments?.length) {
			const creds = this.creds ?? await this.#credentials();
			uploaded = await uploadAll(attachments, { token: creds.token, cookies: creds.cookies });
		}
		const t0 = Date.now();
		evento("PETICION", {
			usuario: key, conv: entry.convId, idx: entry.gw.messageIndex,
			reply_to: entry.gw.replyTo, adjuntos: uploaded.length,
			chars: prompt.length, prompt: prompt.replace(/\s+/g, " ").slice(0, 120),
		});
		let nudge = null;
		// El frame DGW tiene el largo en u16 (65535 bytes): un prompt grande no
		// entra en un solo turno. Se parte en trozos y cada trozo va como un
		// turno seguido en el MISMO hilo (meta guarda el contexto en su lado).
		// Solo se usa la respuesta del ULTIMO trozo: las partes anteriores solo
		// existen para entregar el contexto.
		const piezas = dividirPrompt(prompt, MAX_PROMPT_BYTES);
		if (piezas.length > 1) {
			evento("PROMTO_PARTIDO", {
				usuario: key, conv: entry.convId, partes: piezas.length,
				chars: prompt.length, max_pieza: MAX_PROMPT_BYTES,
			});
		}
		let text = "", reqId = null, responseId = null, images = [], response = null;
		for (let i = 0; i < piezas.length; i++) {
			const ultima = i === piezas.length - 1;
			const r = await entry.gw.chat(piezaDeContexto(piezas[i], i, piezas.length), {
				// el texto solo se streamea en la ultima parte: si no, el
				// cliente veria los "OK" de las partes intermedias.
				onText: ultima ? onText : undefined,
				onJson: ultima ? onJson : undefined,
				attachments: i === 0 ? uploaded : [],
				idleMs: this.idleMs,
				deadlineMs: presupuestoMs ? Math.min(this.deadlineMs, presupuestoMs) : this.deadlineMs,
				watchdogMs, watchdogPrompt,
				onWatchdog: (info) => {
					nudge = { ms: info.ms, prompt: watchdogPrompt };
					evento("WATCHDOG", { usuario: key, conv: entry.convId, ms: info.ms, enviado: watchdogPrompt });
				},
			});
			if (ultima) ({ text, reqId, responseId, images, response } = r);
		}
		// las imagenes generadas llegan como URL CDN firmada (caduca): se bajan
		const bajadas = await downloadImages(images, { convId: entry.convId });
		evento("RESPUESTA", {
			usuario: key, conv: entry.convId, ms: Date.now() - t0, chars: (text ?? "").length,
			imagenes: bajadas.length, response_id: responseId,
			texto: (text ?? "").replace(/\s+/g, " ").slice(0, 120),
		});
		entry.lastUsed = Date.now();
		entry.depth = entry.gw.depth;
		entry.replyTo = entry.gw.replyTo;
		entry.messageIndex = entry.gw.messageIndex;

		// Titulo del chat: identificacion visual de a que usuario/canal
		// pertenece. El prefijo es el id real (user:canal) y detras va el texto
		// real del primer mensaje, para reconocer la sala de un vistazo en la
		// lista de chats de meta.
		if (!entry.title && this.gql) {
			const prefijo = `[${this.#roomId(key)}]`;
			const texto = prompt.replace(/\s+/g, " ").trim().slice(0, 70);
			entry.title = texto ? `${prefijo} ${texto}` : prefijo;
			try {
				await this.gql.rename(entry.convId, entry.title);
			} catch (err) {
				this.lastWarn = `rename fallo: ${err.message}`;
			}
		}

		const stored = {
			...(this.store[key] ?? {}),
			convId: entry.convId,
			title: entry.title,
			auth: this.auth.modo,
			depth: entry.depth,
			replyTo: entry.replyTo ?? null,
			messageIndex: entry.messageIndex ?? 0,
			updatedAt: new Date().toISOString(),
		};
		this.store[key] = stored;
		saveStoreEntry(key, stored);

		return {
			text, conversationId: entry.convId, userId: this.creds?.userId ?? null,
			renewed, reconnect: reconnect || !!entry.reopened,
			nudge, response,
			images: bajadas.map((i) => ({ url: i.url, mime: i.mime, bytes: i.bytes, path: i.path })),
		};
	}

	/** Chats del usuario (vista de "canales"): [{ conversationId, title }] */
	async listConversations() {
		await this.#credentials();
		if (!this.gql) return [];
		try { return await this.gql.conversations(); } catch { return []; }
	}

	close() {
		for (const c of this.channels.values()) {
			try { c.gw.close(); } catch { /* ignore */ }
		}
		this.channels.clear();
	}
}

export { GatewayError, CLOSE };
