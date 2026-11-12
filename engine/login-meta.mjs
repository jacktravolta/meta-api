// login-meta.mjs — estado REAL de la sesion propia de Meta y helpers del login.
//
// El motor GraphQL usa engine/.session.json (token + cookies, 0600). Cuando ese
// archivo falta o caduca, el motor cae a INVITADO en silencio y el usuario no
// entiende por que. Este modulo expone ese estado con honestidad y permite el
// login manual: abrir una ventana de Chrome VISIBLE con perfil PROPIO, iniciar
// sesion en meta.ai y guardar la sesion capturada.
//
// Regla dura: NUNCA se devuelve ni se loguea el token ni el valor de las
// cookies. Solo nombres de cookie, marcas de tiempo y estados.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as session from "./session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_CAPTURA = path.join(HERE, "capture-session.mjs");
const URL_META = "https://www.meta.ai/";

/** Puerto CDP del navegador con la sesion de meta (el mismo que usa server.mjs). */
function puertoPorDefecto() {
	return Number(process.env.META_SESSION_CDP || 9298);
}

/**
 * Perfil PROPIO del login.
 *
 * NO puede ser el del broker (google-chrome-beta-debug): killStrays() mata por
 * --user-data-dir del broker, asi que compartir perfil mataria el login cada
 * vez que se reinicia la API.
 */
function perfilPorDefecto() {
	return process.env.META_SESSION_PROFILE || "/home/test/.config/google-chrome-meta-login";
}

/** Binario de Chrome (el mismo que usa server.mjs). */
function binarioChrome() {
	return process.env.META_CHROME || "/usr/bin/google-chrome-beta";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function displayActual() {
	return process.env.DISPLAY || null;
}

/** Existe el binario de Chrome y se puede ejecutar. */
function chromeDisponible() {
	try {
		fs.accessSync(binarioChrome(), fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Lee la sesion. Por defecto el archivo real (engine/.session.json); con
 * `archivoSesion` se puede apuntar a otra ruta (tests, otro perfil).
 */
function leerSesion(archivoSesion) {
	if (!archivoSesion) return session.load();
	try {
		return JSON.parse(fs.readFileSync(archivoSesion, "utf8"));
	} catch {
		return null;
	}
}

/** Recorta un texto para los mensajes de error (nunca inventar: se recorta lo real). */
function recortar(texto, max = 300) {
	const t = String(texto || "").trim().replace(/\s+/g, " ");
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** El puerto CDP responde (/json/version). */
async function cdpResponde(puerto, timeoutMs = 1500) {
	try {
		const res = await fetch(`http://127.0.0.1:${puerto}/json/version`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Las pestanas que el CDP conoce (/json). [] si no responde. */
async function pestanasCdp(puerto, timeoutMs = 1500) {
	try {
		const res = await fetch(`http://127.0.0.1:${puerto}/json`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return [];
		const datos = await res.json();
		return Array.isArray(datos) ? datos : [];
	} catch {
		return [];
	}
}

/** Hay una pestana de meta.ai abierta en el navegador del puerto. */
async function hayPestanaMeta(puerto) {
	const pestanas = await pestanasCdp(puerto);
	return pestanas.some((p) => p?.type === "page" && /meta\.ai/i.test(String(p.url || "")));
}

/** Cierra un target creado por error (no dejamos pestanas basura abiertas). */
async function cerrarTarget(puerto, id) {
	if (!id) return;
	try {
		await fetch(`http://127.0.0.1:${puerto}/json/close/${encodeURIComponent(id)}`, {
			signal: AbortSignal.timeout(3000),
		});
	} catch {
		/* best effort */
	}
}

/**
 * Abre la pestana de meta.ai en el navegador del puerto CDP.
 *
 * Chrome acepta el destino crudo (/json/new?https://www.meta.ai/) y tambien la
 * forma con ?url=. Se prueban las dos y se VALIDA la pestana creada: si la
 * respuesta no trae una pestana de meta.ai, no se da por buena.
 */
async function abrirPestanaMeta(puerto) {
	const destinos = [
		URL_META,
		`url=${encodeURIComponent(URL_META)}`,
	];
	const creados = [];
	for (const sufijo of destinos) {
		let destino = null;
		try {
			const res = await fetch(`http://127.0.0.1:${puerto}/json/new?${sufijo}`, {
				method: "PUT",
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) continue;
			destino = await res.json().catch(() => null);
		} catch {
			continue;
		}
		if (!destino?.id) continue;
		creados.push(destino.id);
		if (/meta\.ai/i.test(String(destino.url || ""))) return { ok: true, url: destino.url };
	}
	// Ninguna respuesta trajo meta.ai: puede que la pestana este navegando.
	for (let i = 0; i < 6; i++) {
		if (await hayPestanaMeta(puerto)) return { ok: true, url: URL_META };
		await sleep(500);
	}
	for (const id of creados) await cerrarTarget(puerto, id);
	return { ok: false };
}

/**
 * Lanza Chrome VISIBLE (nunca headless) con perfil propio y espera a que el
 * puerto CDP responda. El proceso queda desacoplado (detached + unref) para
 * sobrevivir a la API.
 */
async function lanzarChromeSesion({ puerto, perfil, display, timeoutMs }) {
	try {
		fs.mkdirSync(perfil, { recursive: true, mode: 0o700 });
	} catch {
		/* best effort: Chrome tambien crea el perfil */
	}
	const args = [
		`--remote-debugging-port=${puerto}`,
		`--user-data-dir=${perfil}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-gpu",
		"--no-sandbox",
		"about:blank",
	];
	let stderr = "";
	let proc;
	try {
		proc = spawn(binarioChrome(), args, {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, DISPLAY: display },
		});
	} catch (err) {
		return { ok: false, mensaje: `No se pudo lanzar Chrome: ${recortar(err?.message || err, 300)}` };
	}
	// El stderr se lee (para poder informar el fallo REAL) pero no se loguea:
	// puede traer ruido del sistema, nunca credenciales.
	proc.stderr?.on("data", (b) => {
		if (stderr.length < 4000) stderr += b.toString();
	});
	proc.stderr?.unref?.();
	proc.unref();

	const limite = Date.now() + timeoutMs;
	while (Date.now() < limite) {
		if (await cdpResponde(puerto)) return { ok: true };
		if (proc.exitCode !== null) break; // Chrome se cerro solo
		await sleep(400);
	}
	const detalle = recortar(stderr, 400);
	return {
		ok: false,
		mensaje: `Chrome no levanto el puerto CDP ${puerto}${detalle ? `: ${detalle}` : "."}`,
	};
}

/**
 * Estado de la sesion: hay credenciales? el navegador de sesion esta vivo?
 * se puede abrir una ventana?
 *
 * @param {{archivoSesion?: string}} opts
 */
export async function estadoLogin({ archivoSesion } = {}) {
	const creds = leerSesion(archivoSesion);
	const haySesion = !!(creds && String(creds.token || "").trim());
	const puerto = puertoPorDefecto();
	const display = displayActual();
	const cdpActivo = await cdpResponde(puerto);
	const ventanaAbierta = cdpActivo ? await hayPestanaMeta(puerto) : false;
	return {
		haySesion,
		capturadoEn: haySesion && creds.capturedAt ? String(creds.capturedAt) : null,
		cdpPuerto: puerto,
		cdpActivo,
		ventanaAbierta,
		display,
		puedeAbrirVentana: !!display && chromeDisponible(),
	};
}

/**
 * Abre (o reutiliza) la ventana de Chrome con meta.ai para que el operador
 * inicie sesion a mano.
 *
 * @param {{puerto?: number, perfil?: string, timeoutMs?: number}} opts
 */
export async function abrirVentanaLogin({
	puerto = puertoPorDefecto(),
	perfil = perfilPorDefecto(),
	timeoutMs = 25000,
} = {}) {
	const display = displayActual();
	if (!display) {
		return {
			ok: false,
			puerto,
			display: null,
			mensaje:
				"No hay DISPLAY: la ventana de login necesita un escritorio grafico. " +
				"Arranca la API con DISPLAY=:0.0 (el escritorio de la sesion).",
		};
	}
	if (!chromeDisponible()) {
		return {
			ok: false,
			puerto,
			display,
			mensaje:
				`No se encontro el navegador Chrome en "${binarioChrome()}". ` +
				"Instalalo o define META_CHROME con la ruta del binario.",
		};
	}

	if (!(await cdpResponde(puerto))) {
		const lanzado = await lanzarChromeSesion({ puerto, perfil, display, timeoutMs });
		if (!lanzado.ok) {
			return { ok: false, puerto, display, mensaje: lanzado.mensaje };
		}
	}

	const pestana = await abrirPestanaMeta(puerto);
	if (!pestana.ok) {
		return {
			ok: false,
			puerto,
			display,
			mensaje:
				`El navegador de sesion esta en el puerto ${puerto} pero no se pudo abrir la pestana de Meta. ` +
				"Revisa la ventana de Chrome en pantalla.",
		};
	}
	return {
		ok: true,
		puerto,
		display,
		mensaje: "Ventana de Meta abierta. Inicia sesion en ella.",
	};
}

/**
 * Captura la sesion AHORA: ejecuta engine/capture-session.mjs contra el puerto
 * CDP y verifica que engine/.session.json quedo con token.
 *
 * @param {{puerto?: number, timeoutMs?: number}} opts
 */
export async function capturarSesionAhora({
	puerto = puertoPorDefecto(),
	timeoutMs = 180000,
} = {}) {
	const r = await ejecutarCaptura(puerto, timeoutMs);
	if (r.codigo !== 0) {
		return {
			ok: false,
			capturadoEn: null,
			señal: "",
			mensaje: `No se pudo guardar la sesion de Meta: ${r.motivo}`,
		};
	}
	const creds = session.load();
	if (!creds || !String(creds.token || "").trim()) {
		return {
			ok: false,
			capturadoEn: null,
			señal: "",
			mensaje:
				"La captura termino pero engine/.session.json no quedo con token: " +
				"la sesion no se puede usar.",
		};
	}
	return {
		ok: true,
		capturadoEn: creds.capturedAt ? String(creds.capturedAt) : null,
		señal: describirCaptura(creds),
		mensaje: "Sesion guardada.",
	};
}

/** Nombres de las cookies capturadas (NUNCA los valores). */
function describirCaptura(creds) {
	const cookies = String(creds.cookies || "");
	const nombres = [...new Set(
		cookies
			.split(";")
			.map((c) => c.split("=")[0].trim())
			.filter(Boolean),
	)];
	const lista = nombres.length > 6 ? `${nombres.slice(0, 6).join(", ")}…` : nombres.join(", ");
	const texto = nombres.length ? `cookies de meta.ai: ${lista}` : "cookies de meta.ai: ninguna";
	return `${texto} · token capturado (oculto)`;
}

/** Ejecuta el script de captura. Nunca lanza: devuelve codigo + salida real. */
function ejecutarCaptura(puerto, timeoutMs) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[SCRIPT_CAPTURA, String(puerto)],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const codigo = error
					? (typeof error.code === "number" ? error.code : error.killed ? 124 : 1)
					: 0;
				resolve({
					codigo,
					stdout: stdout || "",
					stderr: stderr || "",
					error,
					motivo: motivoReal({ stdout: stdout || "", stderr: stderr || "", error, codigo, timeoutMs }),
				});
			},
		);
	});
}

/**
 * Motivo REAL de un fallo: se saca del stderr del script (que es donde esta
 * el error), quitando el ruido del stack de Node. Si no hay nada util, se dice
 * eso: nunca un mensaje generico sin detalle.
 */
function motivoReal({ stdout, stderr, error, codigo, timeoutMs }) {
	const lineas = String(stderr || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const ruido = /^(node:|throw er|triggerUncaughtException|at\s|\^|\{|\}|errno:|code:|syscall:|address:|port:|target:|guardado:|token:)/;
	const utiles = lineas.filter((l) => !ruido.test(l));
	const conError = utiles.filter((l) => /error|econnrefused|failed|no se|no vino/i.test(l));
	const elegidas = (conError.length ? conError : utiles).slice(0, 3);
	let texto = elegidas.join(" · ");
	if (!texto) {
		const out = String(stdout || "").trim().split("\n").filter(Boolean);
		texto = out.slice(-2).join(" · ");
	}
	if (!texto && error?.killed) {
		texto = `la captura excedio el tiempo limite (${timeoutMs} ms)`;
	}
	if (!texto && error?.message) texto = String(error.message);
	if (!texto) texto = `el script de captura termino con codigo ${codigo}`;
	return recortar(texto, 300);
}

export { URL_META };
