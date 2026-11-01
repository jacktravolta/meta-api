// auth.mjs — autenticacion autonoma contra meta.ai (sin navegador, sin cuenta del usuario).
//
// Flujo (descubierto en los bundles publicos del front actual):
//   1. GET  https://www.meta.ai/            -> si 403, resuelve el challenge x-fb-rd
//   2. POST https://www.meta.ai/api/graphql -> useCreateTempUserMutation
//      doc_id 128302cfa314f375be53f53a266699fd  variables {}
//      => { accessToken: "ecto1:...", abraUserId: "..." }
//   3. (opcional) useAcceptTOSMutation  doc_id d23d76b0aabd36269d370dacabccd810
//      variables { input: { tosRegion: "ROW" } }
//      headers: Authorization: Bearer <accessToken>, x-abra-user-id: <abraUserId>
//   4. El mismo accessToken es el Authorization del WebSocket del gateway:
//      wss://gateway.meta.ai/ws/clippy?...&Authorization=ecto1:<accessToken>
//
// El token NO es la cookie de sesion y NO requiere cuenta: es una credencial
// de invitado. Se cachea en engine/.auth.json (0600, fuera de git) para no
// crear un invitado nuevo en cada arranque.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".auth.json");

export const DOC = {
	createTempUser: "128302cfa314f375be53f53a266699fd",
	acceptTOS: "d23d76b0aabd36269d370dacabccd810",
	fetchTempUserCredentials: "2943394199ee6545d1f0c69d5b6e577f",
	connectionContext: "857db061f63750507640786044a4c684",
};

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const ORIGIN = "https://www.meta.ai";

// jar de cookies en memoria (el challenge x-fb-rd deja una cookie)
let cookies = new Map();

function cookieHeader() {
	return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbCookies(res) {
	const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	for (const c of raw) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
	}
}

async function rawFetch(url, opts = {}) {
	const headers = { ...(opts.headers ?? {}), "user-agent": UA };
	const ck = cookieHeader();
	if (ck) headers.cookie = ck;
	const res = await fetch(url, { ...opts, headers, redirect: "manual" });
	absorbCookies(res);
	return res;
}

// Resuelve el challenge x-fb-rd: GET -> 403 con /__rd_verify_... -> POST -> retry
async function getWithChallenge(url, tries = 3) {
	for (let i = 0; i < tries; i++) {
		const res = await rawFetch(url);
		if (res.status !== 403) return res;
		const body = await res.text();
		const m = body.match(/\/__rd_verify_[^"'\s]*challenge=\d+/);
		if (!m) return res; // 403 sin challenge: otro motivo
		await rawFetch(new URL(m[0], ORIGIN).toString(), { method: "POST" });
	}
	return rawFetch(url);
}

export async function graphql(docId, variables, { token, abraUserId, friendlyName } = {}) {	const headers = {
		"content-type": "application/json",
		"accept": "multipart/mixed, application/json",
		"origin": ORIGIN,
		"referer": `${ORIGIN}/`,
	};
	if (friendlyName) headers["x-fb-friendly-name"] = friendlyName;
	if (token) headers.authorization = `Bearer ${token}`;
	if (abraUserId) headers["x-abra-user-id"] = abraUserId;

	const res = await rawFetch(`${ORIGIN}/api/graphql`, {
		method: "POST",
		headers,
		body: JSON.stringify({ doc_id: docId, variables }),
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		// respuesta multipart de Relay: quedarse con el primer bloque JSON
		const m = text.match(/\{"data":[\s\S]*?\n--/);
		if (m) body = JSON.parse(m[0].replace(/\n--$/, ""));
		else throw new Error(`graphql ${docId}: respuesta no parseable (${res.status}): ${text.slice(0, 200)}`);
	}
	if (!res.ok) throw new Error(`graphql ${docId}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
	return body;
}

/** Crea un usuario invitado y devuelve { accessToken, abraUserId } */
export async function createTempUser() {
	await getWithChallenge(`${ORIGIN}/`);
	const body = await graphql(DOC.createTempUser, {}, { friendlyName: "useCreateTempUserMutation" });
	const r = body?.data?.createTempUser;
	if (!r?.success || !r?.accessToken || !r?.abraUserId)
		throw new Error(`createTempUser fallo: ${JSON.stringify(r).slice(0, 300)}`);
	return { accessToken: r.accessToken, abraUserId: r.abraUserId };
}

/** Acepta los terminos para el invitado (region ROW = fuera de US/UK/BR/KR) */
export async function acceptTOS(token, abraUserId, tosRegion = "ROW") {
	const body = await graphql(DOC.acceptTOS, { input: { tosRegion } }, {
		token, abraUserId, friendlyName: "useAcceptTOSMutation",
	});
	const r = body?.data?.markTOSAsAccepted;
	return { ok: !!r?.success, reason: r?.reason ?? null };
}

/** Estado de credenciales del invitado (incluye tosIsAccepted) */
export async function fetchTempUserCredentials(token, abraUserId) {
	const body = await graphql(DOC.fetchTempUserCredentials, {}, {
		token, abraUserId, friendlyName: "useFetchTempUserCredentialsMutation",
	});
	return body?.data?.fetchTempUserCredentials ?? {};
}

/**
 * Credenciales validas: usa cache si existe, si no crea invitado y acepta TOS.
 * cache: engine/.auth.json (0600)
 */
export async function getCredentials({ force = false, tosRegion = "ROW" } = {}) {
	if (!force) {
		try {
			const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
			if (cached?.accessToken && cached?.abraUserId) return { ...cached, cached: true };
		} catch { /* sin cache */ }
	}
	const { accessToken, abraUserId } = await createTempUser();
	const tos = await acceptTOS(accessToken, abraUserId, tosRegion).catch((e) => ({ ok: false, reason: e.message }));
	const creds = { accessToken, abraUserId, tosAccepted: tos.ok, tosRegion, createdAt: new Date().toISOString() };
	try {
		fs.writeFileSync(CACHE, JSON.stringify(creds, null, 1), { mode: 0o600 });
		fs.chmodSync(CACHE, 0o600);
	} catch { /* cache es opcional */ }
	return { ...creds, cached: false };
}

export function clearCredentials() {
	try { fs.unlinkSync(CACHE); return true; } catch { return false; }
}
