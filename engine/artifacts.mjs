// artifacts.mjs — archivos que produce Meta: sandbox, imagenes y zip.
//
// LO QUE SE DESCUBRIO (2026-11-01, en vivo):
//
// 1) Meta tiene un SANDBOX de archivos. Cuando usa su herramienta de python,
//    los archivos quedan en /mnt/data/... dentro de su sandbox y la respuesta
//    lo menciona (por ejemplo "/mnt/data/sistema-agendamiento.zip 21031 bytes").
//    NO hay URL publica de descarga: el archivo vive en el sandbox de Meta.
//
// 2) El CODIGO que Meta ejecuto en ese sandbox SI viaja por el stream, pero no
//    como bloque de codigo del mensaje: llega en frames[].code (la primitiva
//    de la herramienta). Ese codigo es el que produce el/los archivo(s).
//
// 3) Por eso la forma de "bajar" un archivo de Meta es REPRODUCIR el script
//    aqui: se ejecuta el mismo codigo, con /mnt/data/ redirigido a una carpeta
//    local, y el archivo aparece byte a byte igual (verificado: el zip de meta
//    daba 21031 bytes en su sandbox y 21031 bytes aqui).
//
// 4) Las IMAGENES son otro camino: llegan como GenAIImagePrimitive con una URL
//    CDN firmada (media.mjs las baja) y la API las sirve en /v1/media/...
//
// 5) El codigo lo escribio un modelo: NUNCA se ejecuta en el host. Se ejecuta
//    con agent/sandbox.js (bwrap + systemd scope), que es el mismo limite que
//    usa /v1/agent.

import fs from "node:fs";
import path from "node:path";
import { runSandboxed } from "../agent/sandbox.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Un zip real empieza por PK. */
export function esZip(buf) {
	return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
		(buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/**
 * Archivos que meta menciona en la respuesta (/mnt/data/...) y sus snapshots.
 * @returns {Array<{ruta:string, nombre:string, bytes:number|null, snapshot:string|null}>}
 */
export function detectarArchivos(respuesta) {
	const out = [];
	const vistos = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const v of Object.values(o)) {
			if (typeof v === "string") {
				for (const m of v.matchAll(/(\/mnt\/data\/[^\s"'`,;)]+)/g)) {
					const ruta = m[1];
					if (vistos.has(ruta)) continue;
					vistos.add(ruta);
					const tail = ruta.slice(ruta.lastIndexOf(" ") + 1);
					const bytes = /(\d+)\s*bytes/.test(v) ? Number(RegExp.$1) : null;
					out.push({
						ruta,
						nombre: path.basename(ruta),
						bytes,
						snapshot: null,
					});
				}
			} else if (v && typeof v === "object") {
				if (v.snapshot_handle) {
					out.push({
						ruta: null,
						nombre: null,
						bytes: null,
						snapshot: v.snapshot_handle,
						snapshot_id: v.snapshot_id ?? null,
					});
				}
				walk(v);
			}
		}
	};
	walk(respuesta);
	return out;
}

/**
 * Codigo que meta ejecuto en su sandbox: llega en frames[].code.
 * @returns {string[]} bloques de codigo (los largos primero)
 */
export function codigoDeHerramienta(frames) {
	const out = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o)) {
			if (k === "code" && typeof v === "string" && v.length > 200) out.push(v);
			else if (v && typeof v === "object") walk(v);
		}
	};
	walk(frames);
	return out.sort((a, b) => b.length - a.length);
}

/** URLs que parezcan un archivo descargable. */
export function buscarUrls(respuesta) {
	const out = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const v of Object.values(o)) {
			if (typeof v === "string" && /^https?:\/\//.test(v)) {
				if (/\.zip(\?|$)|attachment|download|file/i.test(v)) out.add(v);
			} else walk(v);
		}
	};
	walk(respuesta);
	return [...out];
}

/** Descarga una URL a disco si es un zip valido. */
export async function bajarUrl(url, destino, { timeoutMs = 120_000 } = {}) {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal, redirect: "follow" });
		clearTimeout(timer);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const buf = Buffer.from(await r.arrayBuffer());
		if (!esZip(buf)) throw new Error(`no es un zip (${buf.length} bytes)`);
		fs.writeFileSync(destino, buf);
		return destino;
	} catch {
		return null;
	}
}

/** Lista los archivos de un arbol (relativos a la raiz). */
function listar(dir, base = dir, acc = []) {
	let entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "__pycache__") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) listar(p, base, acc);
		else acc.push(path.relative(base, p));
	}
	return acc;
}

/**
 * Reproduce localmente los archivos que meta produjo en su sandbox.
 *
 * @param {object} opts
 * @param {Array} opts.frames frames crudos del stream (para el codigo)
 * @param {object} opts.respuesta respuesta acumulada
 * @param {string} opts.dir carpeta donde se materializa (bajo .media)
 * @param {boolean} opts.sandbox ejecutar en el sandbox del repo (default true)
 * @returns {Promise<{archivos: Array, zip: object|null,.error: string|null}>}
 */
export async function materializar({ frames = [], respuesta = null, dir, sandbox = true, timeoutMs = 120_000 } = {}) {
	const out = { archivos: [], zip: null, error: null, ejecucion: null };
	const mencionados = detectarArchivos(respuesta);
	if (!mencionados.length && !frames.length) return out;

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	// (1) URL directa, si la hay
	const zipPath = path.join(dir, "sistema-agendamiento.zip");
	for (const url of buscarUrls(respuesta)) {
		const ok = await bajarUrl(url, zipPath);
		if (ok) {
			out.zip = { nombre: path.basename(zipPath), bytes: fs.statSync(zipPath).size, url: null, ruta: zipPath };
			break;
		}
	}

	// (2) reproducir el script de la herramienta en su sandbox
	const codigos = codigoDeHerramienta(frames);
	if (!out.zip && codigos.length) {
		const sandboxDir = path.join(dir, "sandbox");
		fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
		const codigo = codigos[0].replaceAll("/mnt/data/", `${sandboxDir}/`);
		const script = path.join(dir, "herramienta.py");
		fs.writeFileSync(script, codigo, { mode: 0o600 });

		const cmd = `python3 ${JSON.stringify(script)}`;
		if (sandbox) {
			const res = await runSandboxed(cmd, {
				workdir: dir,
				allowWrite: true,
				allowNetwork: false,
				timeoutMs,
				maxOutputBytes: 64 * 1024,
			});
			out.ejecucion = { sandbox: "bwrap", ok: !!res.ok, denied: !!res.denied, salida: String(res.output ?? "").slice(-2000) };
			if (!res.ok && !res.denied) out.error = res.error ?? "la herramienta fallo en el sandbox";
		} else {
			out.ejecucion = { sandbox: false, ok: true };
		}

		// lo que produjo queda en sandboxDir
		const zips = listar(sandboxDir).filter((f) => f.endsWith(".zip"));
		if (zips.length) {
			const mejor = zips.map((f) => path.join(sandboxDir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
			const destino = path.join(dir, path.basename(mejor));
			if (mejor !== destino) fs.copyFileSync(mejor, destino);
			out.zip = { nombre: path.basename(destino), bytes: fs.statSync(destino).size, ruta: destino };
		}
	}

	// (3) inventario final de lo materializado
	const archivos = listar(dir).filter((f) => !f.endsWith(".herramienta.py"));
	out.archivos = archivos.map((rel) => {
		const abs = path.join(dir, rel);
		let bytes = null;
		try { bytes = fs.statSync(abs).size; } catch { /* ignore */ }
		return {
			nombre: path.basename(rel),
			ruta: rel,
			bytes,
			url: `/v1/media/${rel.split(path.sep).join("/")}`,
		};
	});
	if (out.zip) out.zip.url = out.archivos.find((a) => a.nombre === out.zip.nombre)?.url ?? null;
	return out;
}
