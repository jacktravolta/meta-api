// session.mjs — credenciales de sesion (token ecto1 + cookies) extraidas de una
// captura real, guardadas en engine/.session.json con permisos 0600 (fuera de git).
//
// El token NO se puede inventar: lo emite meta.ai (createTempUser para invitados,
// o el session del navegador para cuentas). Este modulo solo lo recicla desde
// una captura para que el motor protocol-first pueda hablar sin navegador.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, ".session.json");

/** Extrae token + cookies de una captura de mirror-chat/replay */
export function fromCapture(capturePath) {
	const cap = JSON.parse(fs.readFileSync(capturePath, "utf8"));
	const url = cap.sockets?.[0]?.url;
	if (!url) throw new Error("captura sin socket");
	const token = new URL(url).searchParams.get("Authorization");
	if (!token) throw new Error("captura sin Authorization en el socket");
	const cookies = (cap.cookies ?? [])
		.filter((c) => /meta\.ai/.test(c.domain ?? ""))
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
	return {
		token,
		cookies,
		userId: cap.userId ?? null,
		capturedAt: new Date().toISOString(),
		source: path.basename(capturePath),
	};
}

export function save(creds) {
	fs.writeFileSync(FILE, JSON.stringify(creds, null, 1), { mode: 0o600 });
	try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
	return FILE;
}

export function load() {
	try {
		return JSON.parse(fs.readFileSync(FILE, "utf8"));
	} catch {
		return null;
	}
}

export function clear() {
	try { fs.unlinkSync(FILE); return true; } catch { return false; }
}

export { FILE };
