// ajustes.mjs — ajustes en CALIENTE de la API (modo de archivos y modo de auth).
//
// Persistencia: engine/.ajustes.json (0600). El panel lo cambia por HTTP
// (PUT /v1/ajustes) y el cambio aplica al turno siguiente, sin reiniciar.
//
// Si el archivo no existe, mandan los valores por defecto y el entorno:
//   META_FILE_STORAGE=url|local    -> fileStorage
//   META_AUTH_MODE=abierta|api-key -> auth
// Si el archivo existe, el ARCHIVO manda sobre el entorno: es lo que el
// panel cambio en caliente.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Valores permitidos (contrato de la API).
export const FILE_STORAGE_VALORES = ["url", "local"];
export const AUTH_VALORES = ["abierta", "api-key"];

const DEFAULTS = { fileStorage: "url", auth: "abierta" };

// Momento de carga del modulo: sirve de "actualizado" mientras no exista
// archivo (aun no se guardo ningun cambio).
const CARGADO = new Date().toISOString();

// META_AJUSTES_PATH existe para los tests (aislar el archivo real).
function rutaAjustes() {
	return process.env.META_AJUSTES_PATH || path.join(HERE, ".ajustes.json");
}

function desdeEntorno() {
	const fileStorage = String(process.env.META_FILE_STORAGE || "").trim().toLowerCase();
	const auth = String(process.env.META_AUTH_MODE || "").trim().toLowerCase();
	return {
		fileStorage: FILE_STORAGE_VALORES.includes(fileStorage) ? fileStorage : DEFAULTS.fileStorage,
		auth: AUTH_VALORES.includes(auth) ? auth : DEFAULTS.auth,
	};
}

// Lectura del disco. Un archivo corrupto o con valores desconocidos NO rompe
// la API: se usa el valor por defecto (o del entorno) para ese campo.
function leerDisco() {
	const ruta = rutaAjustes();
	let stat = null;
	try { stat = fs.statSync(ruta); } catch { stat = null; }
	if (!stat) return { ...desdeEntorno(), actualizado: CARGADO };
	let datos = null;
	try { datos = JSON.parse(fs.readFileSync(ruta, "utf8")); } catch { datos = null; }
	const base = desdeEntorno();
	return {
		fileStorage: FILE_STORAGE_VALORES.includes(datos?.fileStorage) ? datos.fileStorage : base.fileStorage,
		auth: AUTH_VALORES.includes(datos?.auth) ? datos.auth : base.auth,
		actualizado: typeof datos?.actualizado === "string" ? datos.actualizado : new Date(stat.mtimeMs).toISOString(),
	};
}

// Cache en memoria con invalidacion por mtime: si alguien edita el archivo a
// mano, la API lo toma sin reiniciar.
let cache = null;

export function ajustesActuales() {
	const ruta = rutaAjustes();
	let stat = null;
	try { stat = fs.statSync(ruta); } catch { stat = null; }
	if (!stat) {
		// Sin archivo mandan los valores por defecto y el entorno. NO se cachea:
		// el entorno puede cambiar en caliente (y los tests lo cambian).
		const base = desdeEntorno();
		return { fileStorage: base.fileStorage, auth: base.auth, actualizado: CARGADO };
	}
	const mtimeMs = stat.mtimeMs;
	if (!cache || cache.ruta !== ruta || cache.mtimeMs !== mtimeMs) {
		cache = { ...leerDisco(), ruta, mtimeMs };
	}
	return { fileStorage: cache.fileStorage, auth: cache.auth, actualizado: cache.actualizado };
}

// Escritura atomica (tmp + rename) y modo 600: son credenciales de servicio.
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
 * Guarda un cambio parcial y devuelve el objeto COMPLETO ya aplicado.
 * Lanza un Error con mensaje claro si un valor no es valido (la API lo
 * traduce a 400).
 *
 * @param {{fileStorage?: "url"|"local", auth?: "abierta"|"api-key"}} parcial
 * @returns {{fileStorage: string, auth: string, actualizado: string}}
 */
export function guardarAjustes(parcial = {}) {
	if (!parcial || typeof parcial !== "object" || Array.isArray(parcial)) {
		throw new Error("el cuerpo debe ser un objeto JSON con los campos fileStorage y/o auth");
	}
	const conocidos = Object.keys(parcial).filter((c) => c === "fileStorage" || c === "auth");
	const desconocidos = Object.keys(parcial).filter((c) => !conocidos.includes(c));
	if (desconocidos.length) {
		throw new Error(
			`campo desconocido: ${desconocidos.join(", ")}. Solo se permiten: fileStorage, auth`,
		);
	}

	const actual = ajustesActuales();
	let fileStorage = actual.fileStorage;
	let auth = actual.auth;

	if ("fileStorage" in parcial) {
		if (!FILE_STORAGE_VALORES.includes(parcial.fileStorage)) {
			throw new Error(
				`fileStorage invalido: "${parcial.fileStorage}". Valores permitidos: url, local`,
			);
		}
		fileStorage = parcial.fileStorage;
	}
	if ("auth" in parcial) {
		if (!AUTH_VALORES.includes(parcial.auth)) {
			throw new Error(
				`auth invalido: "${parcial.auth}". Valores permitidos: abierta, api-key`,
			);
		}
		auth = parcial.auth;
	}

	const nuevo = { fileStorage, auth, actualizado: new Date().toISOString() };
	const ruta = rutaAjustes();
	escribir(ruta, nuevo);
	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(ruta).mtimeMs; } catch { mtimeMs = 0; }
	cache = { ...nuevo, ruta, mtimeMs };
	return { fileStorage: nuevo.fileStorage, auth: nuevo.auth, actualizado: nuevo.actualizado };
}

// Lectura al cargar el modulo (el "arranque" de la API).
ajustesActuales();
