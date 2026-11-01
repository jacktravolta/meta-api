// upload.mjs — subida de adjuntos (imagenes, video, PDF) al storage de meta.ai.
//
// Capturado del front real (2026-11-01):
//   1) GET  https://rupload.meta.ai/gen_ai_document_gen_ai_tenant/<uuid>
//      headers: Authorization: OAuth ecto1:<token>
//               desired_upload_handler: genai_document
//               x-entity-length: <bytes>
//               x-entity-digest: sha256 <base64>
//   2) POST misma URL, con el binario crudo en el body
//      headers: + Offset: 0, x-entity-type: <mime>, x-entity-name: <nombre>
//      respuesta: { "media_id": "1115661624206089" }
//
// OJO: el esquema es "OAuth <token>", NO "Bearer <token>" (con Bearer el
// upload responde 400 NotAuthorizedError).
//
// El media_id viaja luego en el envelope: f2.3.1.1 (bigint), con el mime en
// f2.3.6 y el nombre en f2.3.7. El prompt lleva el marcador <|attachment:0|>.

import { createHash, randomUUID } from "node:crypto";
import { evento } from "./eventos.mjs";
import fs from "node:fs";
import path from "node:path";

const ORIGIN = "https://www.meta.ai";
const UPLOAD_BASE = "https://rupload.meta.ai/gen_ai_document_gen_ai_tenant";

const MIME_BY_EXT = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
	".mp4": "video/mp4", ".mov": "video/quicktime", ".txt": "text/plain",
};

/** Normaliza una entrada (data URL, ruta local o Buffer) a { bytes, mime, filename }. */
export function toFile(input, fallbackName = "archivo") {
	if (Buffer.isBuffer(input)) {
		return { bytes: input, mime: "application/octet-stream", filename: fallbackName };
	}
	const s = String(input);
	if (s.startsWith("data:")) {
		const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
		if (!m) throw new Error("data URL invalida");
		const mime = m[1] || "application/octet-stream";
		const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
		const ext = Object.keys(MIME_BY_EXT).find((e) => MIME_BY_EXT[e] === mime) ?? ".bin";
		const name = /\.[a-z0-9]{2,5}$/i.test(fallbackName) ? fallbackName : fallbackName + ext;
		return { bytes, mime, filename: name };
	}
	if (/^https?:\/\//i.test(s)) throw new Error("adjuntos remotos: descargar primero y pasar bytes/data URL");
	const bytes = fs.readFileSync(s);
	const mime = MIME_BY_EXT[path.extname(s).toLowerCase()] ?? "application/octet-stream";
	return { bytes, mime, filename: path.basename(s) };
}

/**
 * Sube un archivo y devuelve el media_id que usa el envelope.
 * @param {{data: string|Buffer, filename?: string, mime?: string}} file
 * @param {{token: string, cookies?: string|null}} creds
 */
export async function uploadFile(file, { token, cookies = null } = {}) {
	if (!token) throw new Error("upload: falta el token ecto1");
	const t0 = Date.now();
	const { bytes, mime, filename } = toFile(file.data ?? file, file.filename ?? "archivo");
	const digest = "sha256 " + createHash("sha256").update(bytes).digest("base64");
	const url = `${UPLOAD_BASE}/${randomUUID()}`;

	const baseHeaders = {
		Authorization: `OAuth ${token}`,
		Referer: `${ORIGIN}/`,
		"desired_upload_handler": "genai_document",
		// el server valida estas dos (sin ellas responde NotAuthorizedError)
		"ecto_auth_token": "true",
		"is_abra_user": "true",
		"x-entity-length": String(bytes.length),
		"x-entity-digest": digest,
	};
	if (cookies) baseHeaders.Cookie = cookies;

	// 1) sondeo (el front lo hace antes de subir)
	try {
		await fetch(url, { headers: { ...baseHeaders, Origin: ORIGIN } });
	} catch { /* opcional */ }

	// 2) subida
	const res = await fetch(url, {
		method: "POST",
		headers: {
			...baseHeaders,
			Origin: ORIGIN,
			Offset: "0",
			"x-entity-type": mime,
			"x-entity-name": filename,
		},
		body: bytes,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`upload ${res.status}: ${text.slice(0, 200)}`);
	let body; try { body = JSON.parse(text); } catch { throw new Error(`upload: respuesta no parseable: ${text.slice(0, 200)}`); }
	const mediaId = body?.media_id ?? body?.mediaId ?? body?.id;
	if (!mediaId) throw new Error(`upload: sin media_id en la respuesta: ${text.slice(0, 200)}`);
	const t1 = Date.now();
	evento("UPLOAD", { archivo: filename, mime, bytes: bytes.length, media_id: String(mediaId), ms: t1 - t0 });
	return { mediaId: String(mediaId), mime, filename, bytes: bytes.length };
}

/** Sube varios adjuntos y devuelve la lista para el envelope. */
export async function uploadAll(files, creds) {
	const out = [];
	for (const f of files) out.push(await uploadFile(f, creds));
	return out;
}
