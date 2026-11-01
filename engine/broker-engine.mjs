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
import { getCredentials, clearCredentials } from "./auth.mjs";
import { MetaGraphQL } from "./meta-graphql.mjs";
import { uploadAll } from "./upload.mjs";
import * as session from "./session.mjs";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, ".conversations.json");

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

export class MetaEngine {
	// idleMs: cuanto se espera el PRIMER frame de la respuesta. Con varias
	// conversaciones simultaneas, el servidor puede encolar y tardar mas de
	// 120 s -> el cliente abortaba (4001 KEEPALIVE_TIMEOUT) y perdia el turno.
	constructor({ mode = "session", idleMs = 180_000, cdpPort = 9298 } = {}) {
		this.mode = mode === "guest" ? "guest" : "session";
		this.idleMs = idleMs;
		this.cdpPort = cdpPort;
		this.channels = new Map(); // key -> { convId, gw, title, lastUsed }
		this.store = loadStore();
		this.creds = null;
		this.gql = null;
	}

	#channelKey(userId, channel) {
		return `${userId || "anon"}:${channel || "default"}`;
	}

	async #credentials(force = false) {
		if (this.creds && !force) return this.creds;
		if (this.mode === "session") {
			const s = session.load();
			if (!s) throw new Error("sin sesion propia: recaptura con engine/capture-session.mjs (META_ENGINE_MODE=guest para usar invitado)");
			this.creds = { token: s.token, cookies: s.cookies, userId: s.userId ?? null };
		} else {
			const c = await getCredentials();
			this.creds = { token: c.accessToken, cookies: null, userId: c.abraUserId };
		}
		this.gql = new MetaGraphQL(this.creds);
		return this.creds;
	}

	/** Credencial nueva: invitado nuevo o recaptura de la sesion propia. */
	async #renew() {
		if (this.mode === "session") {
			await execFileAsync(process.execPath, [
				path.join(HERE, "capture-session.mjs"), String(this.cdpPort),
			], { timeout: 90_000 });
			const s = session.load();
			if (!s) throw new Error("no se pudo recapturar la sesion propia");
			this.creds = null;
			return this.#credentials(true);
		}
		clearCredentials();
		this.creds = null;
		return this.#credentials(true);
	}

	/** conversation_id persistente por usuario/canal. */
	#conversationId(key) {
		const entry = this.store[key];
		if (entry?.convId) return entry.convId;
		const convId = randomUUID();
		const fresh = { convId, title: null, updatedAt: new Date().toISOString() };
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
	 * Envia un mensaje a meta dentro del chat del usuario.
	 * @param {string} prompt
	 * @param {{userId?: string, channel?: string, onText?: (t: string) => void}} opts
	 */
	async ask(prompt, { userId = "anon", channel = "default", onText, attachments = [] } = {}) {
		const key = this.#channelKey(userId, channel);
		let lastError = null;
		let renewed = false;
		let reconnected = false;
		// El try incluye la APERTURA de la conexion: un fallo de DNS o de
		// upgrade no debe costar el turno (medido: 14 EAI_AGAIN en la emulacion
		// de 1 h, cada uno perdia un turno).
		for (let attempt = 0; attempt < 3; attempt++) {
			let entry = null;
			try {
				entry = await this.#conn(key);
				return await this.#send(key, entry, prompt, onText, attachments, renewed, reconnected);
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

	async #send(key, entry, prompt, onText, attachments = [], renewed = false, reconnect = false) {
		// los adjuntos se suben ANTES del request: el envelope solo lleva el
		// media_id (f2.3), no los bytes.
		let uploaded = [];
		if (attachments?.length) {
			const creds = this.creds ?? await this.#credentials();
			uploaded = await uploadAll(attachments, { token: creds.token, cookies: creds.cookies });
		}
		const { text, reqId, responseId } = await entry.gw.chat(prompt, { onText, attachments: uploaded, idleMs: this.idleMs });
		entry.lastUsed = Date.now();
		entry.depth = entry.gw.depth;
		entry.replyTo = entry.gw.replyTo;
		entry.messageIndex = entry.gw.messageIndex;

		// titulo del chat = primer mensaje (como hace el front)
		if (!entry.title && text && this.mode === "session" && this.gql) {
			entry.title = prompt.replace(/\s+/g, " ").slice(0, 80);
			try { await this.gql.rename(entry.convId, entry.title); } catch { /* el titulo no es critico */ }
		}

		const stored = {
			...(this.store[key] ?? {}),
			convId: entry.convId,
			title: entry.title,
			depth: entry.depth,
			replyTo: entry.replyTo ?? null,
			messageIndex: entry.messageIndex ?? 0,
			updatedAt: new Date().toISOString(),
		};
		this.store[key] = stored;
		saveStoreEntry(key, stored);

		return { text, conversationId: entry.convId, userId: this.creds?.userId ?? null, renewed, reconnect: reconnect || !!entry.reopened };
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
