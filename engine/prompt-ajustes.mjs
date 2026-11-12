// prompt-ajustes.mjs — prompt del agente editable por el propietario.
//
// El propietario escribe el prompt en el panel (PUT /v1/prompt) y la API lo
// inyecta en el turno SIGUIENTE, sin reiniciar: server.mjs lo lee del disco
// en CADA turno (cache por mtime), asi que no hace falta invalidar el motor
// cacheado (el motor cachea credenciales, no el prompt).
//
// Persistencia: engine/.prompt-ajustes.json (0600), mismo patron que
// engine/.ajustes.json. NO son credenciales, pero es estado del panel y el
// patron de almacenamiento se mantiene igual (tmp + rename + 600).
//
// El prompt VACIO ("") significa USAR EL PROMPT BASE: es la forma de
// restablecer sin borrar el archivo a mano.
//
// Tope: PROMPT_MAX_CHARS (20000). Un prompt del propietario no puede comerse
// el historial (el frame del gateway tiene un limite): lo que sobra se
// rechaza explicito (400), no se recorta en silencio.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Tope de caracteres del prompt del propietario (documentado en la API). */
export const PROMPT_MAX_CHARS = 20_000;

// META_PROMPT_PATH existe para los tests (aislar el archivo real).
function rutaPrompt() {
	return process.env.META_PROMPT_PATH || path.join(HERE, ".prompt-ajustes.json");
}

// Cache en memoria con invalidacion por mtime: si alguien edita el archivo a
// mano, la API lo toma sin reiniciar (mismo criterio que ajustes.mjs).
let cache = null;

// Lectura del disco. Un archivo corrupto NO rompe la API: se vuelve al prompt
// base (y actualizadoEn null, porque no hay guardado valido que mostrar).
function leerDisco(stat) {
	let datos = null;
	try { datos = JSON.parse(fs.readFileSync(rutaPrompt(), "utf8")); } catch { datos = null; }
	if (!datos || typeof datos.prompt !== "string") {
		return { prompt: "", actualizadoEn: null };
	}
	return {
		prompt: datos.prompt,
		actualizadoEn: typeof datos.actualizadoEn === "string"
			? datos.actualizadoEn
			: new Date(stat.mtimeMs).toISOString(),
	};
}

/**
 * Estado actual del prompt del propietario.
 *
 * @returns {{prompt: string, actualizadoEn: string|null}}
 *   prompt "" = usar el prompt base; actualizadoEn null = nunca se guardo.
 */
export function getPrompt() {
	const ruta = rutaPrompt();
	let stat = null;
	try { stat = fs.statSync(ruta); } catch { stat = null; }
	if (!stat) return { prompt: "", actualizadoEn: null };
	const mtimeMs = stat.mtimeMs;
	if (!cache || cache.ruta !== ruta || cache.mtimeMs !== mtimeMs) {
		cache = { ...leerDisco(stat), ruta, mtimeMs };
	}
	return { prompt: cache.prompt, actualizadoEn: cache.actualizadoEn };
}

// Escritura atomica (tmp + rename) y modo 600: mismo patron que ajustes.mjs.
function escribir(ruta, datos) {
	fs.mkdirSync(path.dirname(ruta), { recursive: true });
	const tmp = `${ruta}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, ruta);
	// El rename conserva el modo del tmp, pero por si el archivo ya existia
	// con otros permisos se reafirma el 600.
	fs.chmodSync(ruta, 0o600);
}

/**
 * Guarda el prompt del propietario. Acepta el CUERPO de la peticion
 * ({ prompt: string }) y devuelve el estado ya aplicado. Lanza un Error con
 * mensaje claro si algo no es valido (la API lo traduce a 400).
 *
 * "" es el reset: vuelve al prompt base sin borrar el archivo (queda
 * constancia del guardado en actualizadoEn).
 *
 * @param {{prompt?: unknown}} cuerpo
 * @returns {{prompt: string, actualizadoEn: string}}
 */
export function savePrompt(cuerpo = {}) {
	if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
		throw new Error("el cuerpo debe ser un objeto JSON con el campo prompt");
	}
	const desconocidos = Object.keys(cuerpo).filter((c) => c !== "prompt");
	if (desconocidos.length) {
		throw new Error(`campo desconocido: ${desconocidos.join(", ")}. Solo se permite: prompt`);
	}
	if (typeof cuerpo.prompt !== "string") {
		throw new Error("prompt invalido: tiene que ser un texto. Con \"\" se restablece el prompt base");
	}
	if (cuerpo.prompt.length > PROMPT_MAX_CHARS) {
		throw new Error(
			`el prompt excede el maximo de ${PROMPT_MAX_CHARS} caracteres (llego a ${cuerpo.prompt.length}). ` +
			"Recortalo y vuelve a guardar",
		);
	}

	const nuevo = { prompt: cuerpo.prompt, actualizadoEn: new Date().toISOString() };
	const ruta = rutaPrompt();
	escribir(ruta, nuevo);
	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(ruta).mtimeMs; } catch { mtimeMs = 0; }
	cache = { ...nuevo, ruta, mtimeMs };
	return { prompt: nuevo.prompt, actualizadoEn: nuevo.actualizadoEn };
}
