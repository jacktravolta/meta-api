// broker-engine.mjs — adaptador del motor protocol-first (gateway DGW) para el
// broker HTTP. Sin navegador: el token de invitado se crea/renueva solo.
//
//   const engine = new MetaEngine({ mode: "guest" | "session" });
//   const { text } = await engine.ask("hola", { conversationKey: "user-42", onText });
//
// Continuidad de conversacion: cada `conversationKey` (por defecto "default")
// mantiene su propia conexion WS y su conversation id, de modo que varias
// llamadas seguidas forman un hilo. Al renovar credenciales (token de invitado
// caduca ~30-60 min) el hilo se reinicia: el contexto vive en el servidor.

import { MetaGateway, GatewayError, CLOSE } from "./gateway.mjs";
import { getCredentials, clearCredentials } from "./auth.mjs";
import * as session from "./session.mjs";
import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60_000; // una conexion sin uso se cierra

export class MetaEngine {
	constructor({ mode = "guest", idleMs = 120_000 } = {}) {
		this.mode = mode === "session" ? "session" : "guest";
		this.idleMs = idleMs;
		this.conns = new Map(); // key -> { gw, convId, userId, lastUsed }
		this.creds = null;
	}

	async #credentials(force = false) {
		if (this.creds && !force) return this.creds;
		if (this.mode === "session") {
			const s = session.load();
			if (!s) throw new Error("sin sesion propia guardada (engine/.session.json): usa META_ENGINE=guest o captura con engine/mirror-chat.mjs");
			this.creds = { token: s.token, cookies: s.cookies, userId: s.userId ?? null };
		} else {
			const c = await getCredentials();
			this.creds = { token: c.accessToken, cookies: null, userId: c.abraUserId };
		}
		return this.creds;
	}

	async #renew() {
		if (this.mode === "session") {
			// la sesion propia no se puede renovar sin navegador: se avisa
			session.clear();
			this.creds = null;
			throw new Error("el token de la sesion propia caduco: recaptura con engine/mirror-chat.mjs");
		}
		clearCredentials(); // el invitado cacheado caduco: crear uno nuevo
		this.creds = null;
		return this.#credentials(true);
	}

	async #conn(conversationKey) {
		const now = Date.now();
		// poda de conexiones inactivas
		for (const [key, c] of this.conns) {
			if (now - c.lastUsed > DEFAULT_TTL_MS) {
				try { c.gw.close(); } catch { /* ignore */ }
				this.conns.delete(key);
			}
		}
		let entry = this.conns.get(conversationKey);
		if (entry && !entry.gw.isClosed()) {
			entry.lastUsed = now;
			return entry;
		}
		const creds = await this.#credentials();
		const gw = new MetaGateway({
			token: creds.token,
			cookies: creds.cookies,
			userId: creds.userId,
			conversationId: randomUUID(),
		});
		await gw.connect();
		entry = { gw, convId: gw.conversationId, userId: creds.userId, lastUsed: now };
		this.conns.set(conversationKey, entry);
		return entry;
	}

	/**
	 * Envia un mensaje a meta y devuelve el texto final.
	 * @param {string} prompt
	 * @param {{conversationKey?: string, onText?: (t: string) => void}} opts
	 */
	async ask(prompt, { conversationKey = "default", onText } = {}) {
		let entry = await this.#conn(conversationKey);
		try {
			const { text } = await entry.gw.chat(prompt, { onText, idleMs: this.idleMs });
			entry.lastUsed = Date.now();
			return { text, conversationId: entry.convId, userId: entry.userId };
		} catch (err) {
			const authError = err instanceof GatewayError
				&& (err.code === CLOSE.UNAUTHORIZED || err.code === CLOSE.REJECTED);
			if (!authError) throw err;
			// credencial caducada: renovar y reintentar una vez (hilo nuevo)
			try { entry.gw.close(); } catch { /* ignore */ }
			this.conns.delete(conversationKey);
			await this.#renew();
			entry = await this.#conn(conversationKey);
			const { text } = await entry.gw.chat(prompt, { onText, idleMs: this.idleMs });
			entry.lastUsed = Date.now();
			return { text, conversationId: entry.convId, userId: entry.userId, renewed: true };
		}
	}

	close() {
		for (const c of this.conns.values()) {
			try { c.gw.close(); } catch { /* ignore */ }
		}
		this.conns.clear();
	}
}

export { GatewayError, CLOSE };
