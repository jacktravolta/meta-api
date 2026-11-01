// abra.mjs — cliente del protocolo reverse-engineered de Meta AI, sin navegador.
//
// La idea es la de baileys para WhatsApp: hablar el protocolo directamente,
// no tipear sobre el DOM. La tecnica (doc_ids de Relay, tokens de bootstrap,
// NDJSON de streaming) esta extraida del cliente abierto Strvm/meta-ai-api.
//
// Flujo invitado (temp-user, sin login):
//   1. bootstrap  — GET https://www.meta.ai/      -> _js_datr, datr, lsd, abra_csrf
//   2. aceptarTOS — POST www.meta.ai/api/graphql/ -> access_token de temp-user
//   3. enviar     — POST graph.meta.ai/graphql?locale=user (NDJSON)
//
// cero dependencias: usa fetch nativo de Node >= 22.

import { setTimeout as sleep } from "node:timers/promises";

const BOOTSTRAP_URL = "https://www.meta.ai/";
const TOS_URL = "https://www.meta.ai/api/graphql/";
const GRAPH_URL = "https://graph.meta.ai/graphql?locale=user";

// doc_ids de Relay modern que el frontend de meta.ai usa en produccion.
const DOC_ACCEPT_TOS = "7604648749596940"; // useAbraAcceptTOSForTempUserMutation
const DOC_SEND = "7783822248314888"; // useAbraSendMessageMutation

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// extrae el valor entre dos marcadores del HTML inicial (pagina de meta.ai lo
// incrusta dentro de su payload de arranque, sin markup estable para un parser real).
function extractValue(text, startStr, endStr) {
	const start = text.indexOf(startStr);
	if (start < 0) return null;
	const from = start + startStr.length;
	const end = text.indexOf(endStr, from);
	if (end < 0) return null;
	let value = "";
	for (let i = from; i < end; ++i) {
		const c = text[i];
		if (c === "\\" && i + 1 < end) {
			value += text[i + 1];
			++i;
			continue;
		}
		if (c === '"') break;
		value += c;
	}
	return value || null;
}

// offlineThreadingId: (timestamp_ms << 22) | random(22 bits), como BigInt decimal.
function offlineThreadingId() {
	const ts = BigInt(Date.now());
	const rand = BigInt.asUintN(22, BigInt(Math.floor(Math.random() * (1 << 22))));
	return String((ts << 22n) | rand);
}

function uuid() {
	return crypto.randomUUID();
}

class Jar {
	constructor() {
		this.cookies = new Map(); // name -> { value, domain }
	}
	// absorbe Set-Cookie de una respuesta (mismo Namespace que undici devuelve
	// como multi-valued getSetCookie).
	ingest(url, headers) {
		const cookies = headers.getSetCookie?.() ?? [];
		for (const raw of cookies) {
			const first = raw.split(";")[0];
			const eq = first.indexOf("=");
			if (eq <= 0) continue;
			const name = first.slice(0, eq).trim();
			const value = first.slice(eq + 1).trim();
			let domain = url.hostname;
			const dm = /;\s*domain=([^;]+)/i.exec(raw);
			if (dm) domain = dm[1].replace(/^\./, "").toLowerCase();
			this.cookies.set(name, { value, domain });
		}
	}
	header(host) {
		const h = host.replace(/^www\./, "");
		const parts = [];
		for (const [name, { value, domain }] of this.cookies) {
			const d = domain.replace(/^\./, "");
			if (h === d || h.endsWith("." + d)) parts.push(`${name}=${value}`);
		}
		return parts.join("; ");
	}
}

// form-urlencode "a lo Python": las claves compuestas se aplanan con corchetes.
function urlencode(payload) {
	const parts = [];
	for (const [k, v] of Object.entries(payload)) {
		parts.push(
			`${encodeURIComponent(k)}=${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))}`,
		);
	}
	return parts.join("&");
}

// analiza el stream NDJSON de graph.meta.ai: una linea = un JSON.
// la respuesta final trae bot_response_message.streaming_state === "OVERALL_DONE".
function parseNdjson(raw) {
	const lines = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			lines.push(JSON.parse(t));
		} catch {
			// las lineas del stream vienen una por una; el padding raro se descarta
		}
	}
	return lines;
}

function composedTextFrom(jsonLine) {
	const msg = jsonLine?.data?.node?.bot_response_message ?? {};
	let text = "";
	for (const content of msg.composed_text?.content ?? []) {
		text += (content.text ?? "") + "\n";
	}
	return text.replace(/\n+$/, "");
}

async function postJson(jar, url, body, headers) {
	const r = await fetch(url, {
		method: "POST",
		headers: {
			"user-agent": UA,
			...headers,
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});
	jar.ingest(url, r.headers);
	return r;
}

// crea una sesion invitada completa: bootstrap + token temp-user.
export async function createSession(opts = {}) {
	const jar = new Jar();
	const log = opts.log ?? (() => {});

	// 1. bootstrap: la pagina inicial incrusta los tokens CSRF.
	const b = await fetch(BOOTSTRAP_URL, { headers: { "user-agent": UA } });
	jar.ingest(BOOTSTRAP_URL, b.headers);
	const html = await b.text();
	const toks = {
		_js_datr: extractValue(html, '_js_datr":{"value":"', '",'),
		datr: extractValue(html, 'datr":{"value":"', '",'),
		lsd: extractValue(html, '"LSD",[],{"token":"', '"}'),
		abra_csrf: extractValue(html, 'abra_csrf":{"value":"', '",'),
	};
	for (const [k, v] of Object.entries(toks)) {
		if (!v) throw new Error(`bootstrap fallo: falta ${k} (posible region bloqueada o DiegoHN)`);
		jar.cookies.set(k, { value: v, domain: "meta.ai" });
	}
	log(`bootstrap ok (datr=${toks.datr.slice(0, 6)}...)`);

	// 2. aceptar TOS como temp-user para obtener access_token.
	const tosBody = urlencode({
		lsd: toks.lsd,
		fb_api_caller_class: "RelayModern",
		fb_api_req_friendly_name: "useAbraAcceptTOSForTempUserMutation",
		variables: {
			dob: "1999-01-01",
			icebreaker_type: "TEXT",
			__relay_internal__pv__WebPixelRatiorelayprovider: 1,
		},
		doc_id: DOC_ACCEPT_TOS,
	});
	const t = await postJson(jar, TOS_URL, tosBody, {
		cookie: `_js_datr=${toks._js_datr}; abra_csrf=${toks.abra_csrf}; datr=${toks.datr}`,
		sec_fetch_site: "same-origin",
		x_fb_friendly_name: "useAbraAcceptTOSForTempUserMutation",
	});

	return new AbraSession(jar, t);
}

class AbraSession {
	constructor(jar, tosResponse) {
		this._jar = jar;
		this._tosResponse = tosResponse;
		this._accessToken = null;
		this.conversationId = null;
	}

	async _accessToken_once() {
		if (this._accessToken) return this._accessToken;
		const raw = await this._tosResponse.text();
		let json;
		try {
			json = JSON.parse(raw);
		} catch {
			throw new Error(`aceptarTOS: respuesta no es JSON (${raw.slice(0, 120)})`);
		}
		const token =
			json?.data?.xab_abra_accept_terms_of_service?.new_temp_user_auth?.access_token;
		if (!token)
			throw new Error(`aceptarTOS: sin access_token: ${JSON.stringify(json).slice(0, 200)}`);
		this._accessToken = token;
		await sleep(1000); // meta rechaza el envio inmediato luego del TOS
		return token;
	}

	// envia un prompt y devuelve el texto final. Si no llega OVERALL_DONE
	// reintenta (max 3), como el cliente de referencia.
	async send(message, { attempts = 0 } = {}) {
		const token = await this._accessToken_once();
		if (!this.conversationId) this.conversationId = uuid();
		const body = urlencode({
			access_token: token,
			fb_api_caller_class: "RelayModern",
			fb_api_req_friendly_name: "useAbraSendMessageMutation",
			variables: {
				message: { sensitive_string_value: message },
				externalConversationId: this.conversationId,
				offlineThreadingId: offlineThreadingId(),
				suggestedPromptIndex: null,
				flashVideoRecapInput: { images: [] },
				flashPreviewInput: null,
				promptPrefix: null,
				entrypoint: "ABRA__CHAT__TEXT",
				icebreaker_type: "TEXT",
				__relay_internal__pv__AbraDebugDevOnlyrelayprovider: false,
				__relay_internal__pv__WebPixelRatiorelayprovider: 1,
			},
			server_timestamps: "true",
			doc_id: DOC_SEND,
		});
		const r = await postJson(this._jar, GRAPH_URL, body, {
			cookie: this._jar.header("graph.meta.ai"),
			x_fb_friendly_name: "useAbraSendMessageMutation",
		});
		const raw = await r.text();
		const lines = parseNdjson(raw);

		let final = null;
		let errored = lines.some((l) => (l.errors?.length ?? 0) > 0);
		for (const line of lines) {
			const bot = line?.data?.node?.bot_response_message ?? {};
			const chatId = bot.id;
			if (chatId) {
				// el id trae "externalConversationId_offlineThreadingId_...": mantiene vivo el hilo
				this.conversationId = String(chatId).split("_")[0];
			}
			if (bot.streaming_state === "OVERALL_DONE") final = line;
		}
		if (!final || errored) {
			if (attempts < 3) {
				await sleep(3000);
				return this.send(message, { attempts: attempts + 1 });
			}
			throw new Error(
				`envio: sin OVERALL_DONE tras 4 intentos. Primeras lineas: ${raw.slice(0, 160)}`,
			);
		}
		return {
			text: composedTextFrom(final),
			conversationId: this.conversationId,
			// fetch_id para plugin de busqueda / imagenes: disponible por si se quiere extender
			fetchId: final?.data?.node?.bot_response_message?.fetch_id ?? null,
			raw: exclusivo(final),
		};
	}
}

// recorta el crudo de respuesta para logs: evita volcar 100KB por linea
function exclusivo(line) {
	const s = JSON.stringify(line);
	return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
}

export function _testCaptureJar() {
	return { Jar, offlineThreadingId, extractValue, parseNdjson, composedTextFrom, urlencode, uuid };
}
