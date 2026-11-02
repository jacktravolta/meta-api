// dump.mjs — volcado de diagnostico (opt-in: META_DUMP=1).
//
// Cuando esta activo deja tres tipos de fichero en META_DUMP_DIR (0700):
//   request-*.json  lo que el cliente (opencode) mando a la API
//   prompt-*.json   lo que la API le mando a meta (prompt + trozos)
//   meta-*.json     los frames crudos que meta devolvio
//
// Sirve para el diagnostico de "meta no responde": sin esto se caza a ciegas.
// Los ficheros tienen 0600 porque contienen el prompt del usuario.

import fs from "node:fs";
import path from "node:path";

const DIR = String(process.env.META_DUMP_DIR || "/tmp/opencode/dump");
let contador = 0;

/** ¿el volcado esta activo? */
export function dumpActivo() {
	return /^(1|true|yes|on)$/i.test(String(process.env.META_DUMP || ""));
}

/**
 * Escribe un volcado. Devuelve la ruta (o null si no esta activo / falla).
 * @param {string} tipo "request" | "prompt" | "meta"
 * @param {any} data
 */
export function volcar(tipo, data) {
	if (!dumpActivo()) return null;
	try {
		fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(DIR, 0o700); } catch { /* ignore */ }
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const archivo = path.join(DIR, `${ts}-${tipo}-${++contador}.json`);
		fs.writeFileSync(archivo, JSON.stringify(data, null, 1), { mode: 0o600 });
		return archivo;
	} catch {
		return null;
	}
}

/** Nombre de fichero seguro para un usuario/canal. */
export function etiqueta(texto) {
	return String(texto ?? "x").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60) || "x";
}
