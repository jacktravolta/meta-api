// apikeys.mjs — credenciales de la API (API keys) y clave interna del webchat.
//
// De una clave de USUARIO se guarda SOLO el hash sha256 en
// engine/.api-keys.json (0600). El secreto se devuelve al crearla y no se
// vuelve a mostrar nunca: listar devuelve el prefijo, no la clave.
//
// La clave de SERVICIO del webchat es otra cosa: es una credencial local entre
// el proxy (webchat/server.py) y la API, no una clave de usuario. Vive EN
// CLARO en engine/.webchat-key (0600) porque el proxy la tiene que leer del
// disco; el proxy la manda en la cabecera X-API-Key.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Formato del secreto: "mk_" + 32 bytes en base64url (43 caracteres).
export const PREFIJO_CLAVE = "mk_";
const BYTES_CLAVE = 32;
// Cuantos caracteres del secreto se muestran para poder distinguirla.
const LARGO_PREFIJO = 12;

// META_API_KEYS_PATH / META_WEBCHAT_KEY_PATH existen para los tests
// (aislar los archivos reales).
function rutaClaves() {
	return process.env.META_API_KEYS_PATH || path.join(HERE, ".api-keys.json");
}
function rutaWebchatKey() {
	return process.env.META_WEBCHAT_KEY_PATH || path.join(HERE, ".webchat-key");
}

function hashDe(secreto) {
	return crypto.createHash("sha256").update(String(secreto), "utf8").digest("hex");
}

function leerClaves() {
	try {
		const datos = JSON.parse(fs.readFileSync(rutaClaves(), "utf8"));
		return Array.isArray(datos?.claves) ? datos.claves : [];
	} catch {
		return [];
	}
}

function escribirClaves(claves) {
	const ruta = rutaClaves();
	fs.mkdirSync(path.dirname(ruta), { recursive: true });
	const tmp = `${ruta}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify({ claves }, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, ruta);
	fs.chmodSync(ruta, 0o600);
}

/**
 * Crea una clave. Devuelve el secreto EN CLARO (se ve una sola vez).
 *
 * @param {{nombre?: string, dias?: number|null}} opts
 * @returns {{id: string, clave: string, nombre: string, expira: string|null}}
 */
export function crearClave({ nombre, dias = null } = {}) {
	const nom = String(nombre ?? "").trim();
	if (!nom) throw new Error("falta 'nombre': un texto corto que identifique la clave");
	if (nom.length > 120) throw new Error("'nombre' demasiado largo (maximo 120 caracteres)");

	let expira = null;
	if (dias !== null && dias !== undefined && dias !== "") {
		const n = Number(dias);
		if (!Number.isInteger(n) || n <= 0) {
			throw new Error(`'dias' invalido: "${dias}". Debe ser un entero positivo o null (sin caducidad)`);
		}
		expira = new Date(Date.now() + n * 86_400_000).toISOString();
	}

	const secreto = PREFIJO_CLAVE + crypto.randomBytes(BYTES_CLAVE).toString("base64url");
	const registro = {
		id: crypto.randomUUID(),
		nombre: nom,
		hash: hashDe(secreto),
		prefijo: secreto.slice(0, LARGO_PREFIJO),
		creado: new Date().toISOString(),
		expira,
		revocado: false,
		ultimoUso: null,
	};
	const claves = leerClaves();
	claves.push(registro);
	escribirClaves(claves);

	// El secreto sale de aqui y no se vuelve a guardar: solo queda su hash.
	return { id: registro.id, clave: secreto, nombre: registro.nombre, expira: registro.expira };
}

/**
 * Lista las claves SIN el secreto.
 * @returns {Array<{id: string, nombre: string, prefijo: string, creado: string, expira: string|null, revocado: boolean, ultimoUso: string|null}>}
 */
export function listarClaves() {
	return leerClaves().map((c) => ({
		id: c.id,
		nombre: c.nombre,
		prefijo: c.prefijo,
		creado: c.creado,
		expira: c.expira ?? null,
		revocado: !!c.revocado,
		ultimoUso: c.ultimoUso ?? null,
	}));
}

/**
 * Revoca una clave (queda invalidada de inmediato).
 * @returns {boolean} true si existia
 */
export function revocarClave(id) {
	const claves = leerClaves();
	const registro = claves.find((c) => c.id === id);
	if (!registro) return false;
	registro.revocado = true;
	escribirClaves(claves);
	return true;
}

/**
 * Verifica una clave presentada. Solo valen las no revocadas y no expiradas.
 * Actualiza "ultimoUso" cuando la clave sirve.
 * @returns {boolean}
 */
export function verificarClave(presentada) {
	if (typeof presentada !== "string" || !presentada.trim()) return false;
	const hash = hashDe(presentada.trim());
	const claves = leerClaves();
	const registro = claves.find((c) => c.hash === hash && !c.revocado);
	if (!registro) return false;
	// Una clave vencida deja de servir (aunque el archivo diga que no).
	if (registro.expira && Date.parse(registro.expira) <= Date.now()) return false;
	registro.ultimoUso = new Date().toISOString();
	escribirClaves(claves);
	return true;
}

/**
 * Clave interna de servicio para el webchat (el proxy local la lee del disco
 * y la manda en X-API-Key). Se genera sola la primera vez, en claro, con
 * modo 600.
 * @returns {string}
 */
export function claveServicioWebchat() {
	const ruta = rutaWebchatKey();
	try {
		const guardada = fs.readFileSync(ruta, "utf8").trim();
		if (guardada) return guardada;
	} catch {
		// todavia no existe: se genera
	}
	const clave = PREFIJO_CLAVE + crypto.randomBytes(BYTES_CLAVE).toString("base64url");
	fs.mkdirSync(path.dirname(ruta), { recursive: true });
	const tmp = `${ruta}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, clave + "\n", { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, ruta);
	fs.chmodSync(ruta, 0o600);
	return clave;
}

/**
 * Compara (en tiempo constante) la clave presentada con la de servicio del
 * webchat.
 * @returns {boolean}
 */
export function esClaveServicioWebchat(presentada) {
	if (typeof presentada !== "string" || !presentada.trim()) return false;
	let guardada = "";
	try {
		guardada = fs.readFileSync(rutaWebchatKey(), "utf8").trim();
	} catch {
		return false;
	}
	if (!guardada) return false;
	const a = Buffer.from(guardada, "utf8");
	const b = Buffer.from(presentada.trim(), "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}
