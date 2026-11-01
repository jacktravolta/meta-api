// eventos.mjs — espejo estructurado del motor (peticiones, uploads, imagenes).
//
//   tail -f bridge/engine-eventos.txt
//
// Una linea por evento, legible; en paralelo bridge/engine-eventos.jsonl para
// consumo programatico. NUNCA se escribe el prompt completo ni PII: solo un
// recorte (120 chars) y metadatos.
//
// Archivos de runtime: no se versionan (ver .gitignore).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..", "bridge");
const TXT = path.join(DIR, "engine-eventos.txt");
const JSONL = path.join(DIR, "engine-eventos.jsonl");

const recorte = (v, max = 120) => {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Registra un evento. tipo: PETICION | RESPUESTA | UPLOAD | IMG_BAJADA | ERROR… */
export function evento(tipo, campos = {}) {
	const ts = new Date().toISOString();
	const partes = Object.entries(campos)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}=${typeof v === "number" || typeof v === "boolean" ? v : recorte(v)}`);
	const linea = `[${ts.slice(11, 19)}] ${tipo} ${partes.join(" ")}`;
	try {
		fs.mkdirSync(DIR, { recursive: true });
		fs.appendFileSync(TXT, linea + "\n");
		fs.appendFileSync(JSONL, JSON.stringify({ ts, tipo, ...campos }) + "\n");
	} catch { /* el espejo nunca debe tumbar una peticion */ }
	return linea;
}
