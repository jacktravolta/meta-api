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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSandboxed } from "../agent/sandbox.js";
import { bloquesDe } from "./codigo.mjs";

const execFileAsync = promisify(execFile);

// Raiz que sirve /v1/media (la API la usa como join(import.meta.dirname,
// "engine", ".media")). Las URLs de los archivos se arman RELATIVAS a esta
// raiz: relativas a la carpeta del turno les falta el <convId>/ y dan 404.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(HERE, ".media");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Modo de entrega de los archivos que meta deja en SU sandbox de artefactos:
//
//   "url"   (POR DEFECTO): la API NO guarda copia. Se traspasa al cliente la
//           URL de descarga de meta y el cliente baja DIRECTO de meta.
//   "local": la API baja el archivo a engine/.media/<canal>/... y lo sirve en
//           /v1/media/... (copia en nuestra API, el comportamiento anterior).
//
// Se cambia con META_FILE_STORAGE=local|url.
//
// Los archivos que generamos NOSOTROS (el espejo del codigo que meta ejecuto,
// o el contenido que meta entrego en linea) NO tienen URL de meta: esos
// siempre se sirven desde /v1/media, en cualquier modo.
function modoAlmacen() {
	return String(process.env.META_FILE_STORAGE || "url").toLowerCase() === "local" ? "local" : "url";
}

/**
 * Modo de entrega vigente: el que pide el ajuste del panel ("url"|"local") o,
 * si no viene, el valor por defecto (META_FILE_STORAGE).
 */
export function modoEntrega(modoArchivo = null) {
	return modoArchivo === "local" || modoArchivo === "url" ? modoArchivo : modoAlmacen();
}

/**
 * URL de descarga de un artefacto de meta. La url de meta sirve una PAGINA (el
 * visor del archivo); los bytes crudos salen pidiendo download=1.
 */
function urlDeDescarga(url) {
	try {
		const u = new URL(String(url));
		u.searchParams.set("download", "1");
		return u.toString();
	} catch {
		return String(url || "");
	}
}

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
				// Nombres de archivo citados en el TEXTO ("`presentacion.pptx`",
				// "Archivo: receta.txt"). Meta los anuncia asi cuando crea el
				// archivo con su herramienta interna y no entrega los bytes: sin
				// esto el cliente no puede ni avisar de que el archivo se perdio.
				for (const m of v.matchAll(/`([^`\n/\\]+\.(?:pptx?|docx?|xlsx?|csv|tsv|pdf|zip|txt|md|html?|json|xml|png|jpe?g|webp|gif))`/gi)) {
					const nombre = path.basename(m[1].trim());
					if (!nombre || vistos.has(nombre)) continue;
					vistos.add(nombre);
					out.push({ ruta: null, nombre, bytes: null, snapshot: null });
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
	const vistos = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o)) {
			// El codigo de una herramienta de meta: escribe en SU sandbox
			// (/mnt/data/...). Ese es el discriminador fiable: TODOS los scripts
			// que meta ejecuta para dejar un archivo tocan /mnt/data/, y el
			// codigo de otras herramientas que viaja en la respuesta (el del
			// cliente, por ejemplo) NO lo toca -> no se ejecuta aqui.
			// No se exige un largo minimo alto: meta escribe scripts de dos
			// lineas para un .txt y, con el umbral viejo (>200 chars), ese
			// archivo nunca se entregaba (medido 2026-11-02).
			if (k === "code" && typeof v === "string" && v.length >= 20 && v.includes("/mnt/data/")) {
				// El mismo script llega repetido en muchos frames: se guarda una
				// sola vez y EN ORDEN DE APARICION, porque ese orden es la
				// secuencia en que meta los ejecuto en su sandbox.
				if (vistos.has(v)) continue;
				vistos.add(v);
				out.push(v);
			} else if (v && typeof v === "object") walk(v);
		}
	};
	walk(frames);
	return out;
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

/**
 * Descarga una URL a disco. Por defecto solo acepta un zip valido (la via de
 * la URL directa: de entre varias urls candidatas solo sirve la del zip).
 * Con exigirZip:false se baja el archivo tal cual (recursos del sandbox).
 *
 * @returns {Promise<string|null>} la ruta escrita, o null si no se pudo bajar
 */
export async function bajarUrl(url, destino, { timeoutMs = 120_000, exigirZip = true } = {}) {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal, redirect: "follow" });
		clearTimeout(timer);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const buf = Buffer.from(await r.arrayBuffer());
		if (!buf.length) throw new Error("respuesta vacia");
		if (exigirZip && !esZip(buf)) throw new Error(`no es un zip (${buf.length} bytes)`);
		fs.writeFileSync(destino, buf);
		return destino;
	} catch {
		return null;
	}
}

/**
 * RECURSOS DEL SANDBOX DE META (las imagenes que meta genero).
 *
 * El sandbox de meta es POR HILO: un turno genera las imagenes y el turno
 * siguiente las usa (el .pptx usa de fondo las imagenes que estan en
 * "resource/image_x.webp"). Esas imagenes no viven en nuestro espejo: hay que
 * bajarlas del CDN de meta CON el nombre que tienen en su sandbox, o el script
 * del turno siguiente no las encuentra (FileNotFoundError) y no hay archivo.
 *
 * Recurso del sandbox de meta: {source_display_name, url}. El nombre es la
 * ruta dentro del sandbox de meta ("resource/image_x.webp") y la url es la
 * del CDN (caduca: hay que bajarla en el turno).
 *
 * @param {Array|object} frames frames crudos del stream
 * @returns {Array<{nombre: string, url: string}>}
 */
export function recursosDe(frames) {
	const out = [];
	const vistos = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		// El nombre puede venir en el mismo objeto o dentro de su "source".
		const nombre = typeof o.source_display_name === "string" ? o.source_display_name
			: (o.source && typeof o.source.source_display_name === "string" ? o.source.source_display_name : "");
		// La url: primero la vista previa, luego la imagen completa, luego la
		// url suelta del objeto.
		let url = "";
		for (const c of [o.preview_image?.url, o.full_image?.url, o.url]) {
			const s = typeof c === "string" ? c.trim() : "";
			if (/^https?:\/\//i.test(s)) { url = s; break; }
		}
		if (nombre && url && !vistos.has(nombre)) {
			// La galeria de meta va por su propio camino (media.mjs).
			const esGaleria = /(^|\/)gallery\//i.test(nombre) || nombre.includes("/mnt/data/gallery/");
			if (!esGaleria) {
				vistos.add(nombre);
				out.push({ nombre, url });
			}
		}
		for (const v of Object.values(o)) {
			if (v && typeof v === "object") walk(v);
		}
	};
	walk(frames);
	return out;
}

/**
 * Nombre de un recurso dentro del sandbox: es una RUTA RELATIVA
 * ("resource/image_x.webp"). Por seguridad no puede ser absoluta ni salirse
 * de la carpeta del sandbox ("..").
 *
 * @returns {string|null}
 */
function nombreRelativoSeguro(nombre) {
	const n = String(nombre ?? "").trim().replace(/\\/g, "/");
	if (!n || n.startsWith("/")) return null;
	if (/^[a-zA-Z]:/.test(n)) return null; // ruta absoluta de windows
	if (n.split("/").some((p) => p === "..")) return null;
	return n;
}

/**
 * Copia un arbol de archivos (merge: lo nuevo pisa lo viejo) y devuelve los
 * paths RELATIVOS copiados con el mtime que quedaron. Ese mtime sirve para
 * saber despues si un script de ESTE turno reescribio el archivo.
 *
 * @returns {Array<{rel: string, mtimeMs: number}>}
 */
function copiarArbol(origen, destino, omitir = () => false) {
	const copiados = [];
	let entries = [];
	try { entries = fs.readdirSync(origen, { withFileTypes: true }); } catch { return copiados; }
	for (const e of entries) {
		if (omitir(e.name)) continue;
		const src = path.join(origen, e.name);
		const dst = path.join(destino, e.name);
		try {
			if (e.isDirectory()) {
				fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
				for (const c of copiarArbol(src, dst, omitir)) {
					copiados.push({ rel: path.join(e.name, c.rel), mtimeMs: c.mtimeMs });
				}
			} else if (e.isFile()) {
				fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
				fs.copyFileSync(src, dst);
				let mtimeMs = 0;
				try { mtimeMs = fs.statSync(dst).mtimeMs; } catch { /* sin mtime */ }
				copiados.push({ rel: e.name, mtimeMs });
			}
		} catch { /* si no se puede copiar, se sigue */ }
	}
	return copiados;
}

/**
 * Ruta de los helpers de meta en SU sandbox. No existe aqui: los scripts que
 * la importan se apuntan al shim (ver SHIM_HELPERS).
 */
const RUTA_HELPERS_META = "/home/code-interpreter/skills/slides/scripts/render_helpers.py";

/**
 * SHIM DE render_helpers.py.
 *
 * Meta escribe scripts que importan los helpers de SU sandbox
 * (/home/code-interpreter/skills/slides/scripts/render_helpers.py). Ese
 * archivo no existe en nuestra maquina: sin el, el script que dibuja el
 * grafico falla y el .png que produce no sale (y el .pptx que lo usa tampoco).
 *
 * El shim ofrece la misma API que usan los scripts de meta: light_card() y
 * save_and_close(). Solo usa matplotlib.
 */
const SHIM_HELPERS = `# Shim local de render_helpers.py.
#
# Meta ejecuta sus scripts en SU sandbox, donde existe
# /home/code-interpreter/skills/slides/scripts/render_helpers.py. Ese archivo
# no esta en nuestra maquina: este shim ofrece la misma API (light_card y
# save_and_close) para que el script se pueda reproducir aqui.
import os

import matplotlib

try:
    matplotlib.use("Agg")
except Exception:
    pass

import matplotlib.pyplot as plt


def light_card(ink="#202124", grid="#CCCCCC", **kwargs):
    """Figura clara (fondo blanco) con los ejes en el color de tinta."""
    fig, ax = plt.subplots(figsize=kwargs.get("figsize", (10, 6)))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.tick_params(colors=ink)
    for lado in ax.spines.values():
        lado.set_color(ink)
    ax.grid(True, color=grid, linewidth=0.8, alpha=0.8)
    ax.set_axisbelow(True)
    return fig, ax


def save_and_close(fig, ruta, **kwargs):
    """Guarda la figura en la ruta (crea las carpetas) y la cierra."""
    ruta = str(ruta)
    carpeta = os.path.dirname(ruta)
    if carpeta:
        os.makedirs(carpeta, exist_ok=True)
    fig.savefig(ruta, **kwargs)
    plt.close(fig)
    return ruta
`;

/**
 * Escribe el shim de los helpers de meta en el sandbox del turno (una sola
 * vez por turno).
 *
 * @returns {string} la ruta del shim
 */
function escribirShimHelpers(sandboxDir) {
	const dir = path.join(sandboxDir, ".helpers");
	const ruta = path.join(dir, "render_helpers.py");
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(ruta, SHIM_HELPERS, { mode: 0o600 });
	} catch { /* sin shim: los scripts que lo usen fallaran */ }
	return ruta;
}

/**
 * Baja un RECURSO del sandbox de meta (una imagen que genero en un turno
 * anterior) a su ruta dentro del sandbox del turno. Las urls del CDN caducan:
 * hay que bajarlas en el turno.
 *
 * @returns {Promise<string|null>} la ruta absoluta, o null si no se pudo bajar
 */
async function bajarRecurso(url, sandboxDir, nombre) {
	const rel = nombreRelativoSeguro(nombre);
	if (!rel) return null;
	const destino = path.join(sandboxDir, rel);
	if (!destino.startsWith(sandboxDir + path.sep)) return null;
	try { fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 }); } catch { return null; }
	// Si ya esta (lo trajo el cache del hilo), no se vuelve a bajar.
	try { if (fs.statSync(destino).size > 0) return destino; } catch { /* no existe */ }
	const ok = await bajarUrl(url, destino, { exigirZip: false });
	if (!ok) return null;
	// El CDN puede responder con otra cosa (un HTML de error): un archivo que
	// no es imagen rompe el script que lo usa, asi que se descarta.
	try {
		if (detectarTipo(destino).familia !== "imagen") {
			fs.unlinkSync(destino);
			return null;
		}
	} catch { return null; }
	return destino;
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
 * Ejecuta el script que escribio meta, SIN aislamiento, con el python indicado.
 *
 * Modo "local": el sandbox (bwrap) no puede arrancar en esta maquina por falta
 * de capabilities, asi que el codigo se ejecuta en el host con el python del
 * venv del proyecto. El codigo lo escribio un modelo: esto corre en la maquina,
 * sin red bloqueada. La salida se escribe en las carpetas locales de la API.
 */
async function ejecutarLocal(script, { cwd, timeoutMs = 120_000, maxOutputBytes = 64 * 1024 }) {
	const python = process.env.META_ARTIFACT_PYTHON || "python3";
	try {
		const { stdout, stderr } = await execFileAsync(python, [script], {
			cwd,
			timeout: timeoutMs,
			maxBuffer: maxOutputBytes,
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		return { ok: true, salida: `${stdout}${stderr}`.slice(-2000) };
	} catch (err) {
		// El mensaje de execFile viene con el comando entero delante
		// ("Command failed: /ruta/python /ruta/herramienta.py Traceback ...").
		// Al cliente se le da la EXCEPCION (la ultima linea del traceback): dice
		// QUE falto, no como se lanzo.
		const stderr = String(err?.stderr ?? "");
		const lineas = stderr.trim().split("\n").filter(Boolean);
		const ultima = lineas[lineas.length - 1] ?? "";
		const esExcepcion = /^[A-Za-z_.]*(Error|Exception|Interrupt)\b/.test(ultima);
		return {
			ok: false,
			error: esExcepcion ? ultima : (lineas.slice(-2).join(" ").trim() || String(err?.message ?? err)),
			salida: `${err?.stdout ?? ""}${stderr}`.slice(-2000),
		};
	}
}

/**
 * Extension que meta le da a un adjunto segun su tipo. El sandbox de meta
 * nombra los adjuntos "adjunto-N.<ext>" y el script que ejecuto los busca
 * por esa ruta: el espejo tiene que recrearlos con el MISMO nombre.
 */
function extensionDeMime(mime, origen = "") {
	const m = String(mime || "").toLowerCase();
	if (m.includes("pdf")) return ".pdf";
	if (m.includes("csv")) return ".csv";
	if (m.includes("json")) return ".json";
	if (m.includes("spreadsheetml")) return ".xlsx";
	if (m.includes("ms-excel")) return ".xls";
	if (m.includes("wordprocessingml")) return ".docx";
	if (m.includes("opendocument.text")) return ".odt";
	if (m.includes("jpeg")) return ".jpg";
	if (m.includes("png")) return ".png";
	if (m.includes("webp")) return ".webp";
	if (m.includes("gif")) return ".gif";
	if (m.includes("quicktime")) return ".mov";
	if (m.includes("mpeg")) return ".mp4";
	if (m.includes("zip")) return ".zip";
	if (m.includes("plain")) return ".txt";
	// Ruta local: se respeta la extension del archivo.
	const ext = path.extname(String(origen || ""));
	return /^\.[a-z0-9]{1,6}$/i.test(ext) ? ext.toLowerCase() : ".bin";
}

/**
 * Bytes de un adjunto del cliente: data URL, ruta local o URL remota.
 * @returns {Promise<{buf: Buffer, mime: string}|null>}
 */
async function bytesDeAdjunto(src) {
	const s = String(src ?? "");
	const m = /^data:([^;,]*)?;base64,([\s\S]*)$/.exec(s);
	if (m) return { buf: Buffer.from(m[2], "base64"), mime: m[1] || "application/octet-stream" };
	if (/^https?:\/\//i.test(s)) {
		const r = await fetch(s);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") || "application/octet-stream" };
	}
	if (s && fs.existsSync(s)) return { buf: fs.readFileSync(s), mime: "application/octet-stream" };
	return null;
}

/**
 * Artefactos que meta entrega en SU sandbox de artefactos.
 *
 * Vienen como primitive "html_artifact_sandbox", con el nombre real
 * (title), la extension y la url de descarga. Es la via principal para
 * traer un archivo: se baja tal cual, sin ejecutar nada.
 *
 * @returns {Array<{titulo:string, extension:string, url:string, tipo:string}>}
 */
export function artefactosMeta(respuesta) {
	const out = [];
	const vistos = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		const a = o.html_artifact_sandbox;
		if (a && typeof a === "object") {
			const url = String(a.url ?? "");
			if (url && !vistos.has(url)) {
				vistos.add(url);
				out.push({
					titulo: String(a.title ?? "").trim(),
					extension: String(a.file_extension ?? "").trim(),
					url,
					tipo: String(a.artifact_type ?? "").trim(),
					uuid: String(a.uuid ?? "").trim() || null,
				});
			}
		}
		for (const v of Object.values(o)) {
			if (v && typeof v === "object") walk(v);
		}
	};
	walk(respuesta);
	return out;
}

/**
 * Nombre de archivo a partir del titulo que da meta.
 *
 * Meta titula el artefacto ("PDF de prueba con titulo") y manda la extension
 * aparte ("pdf"): el archivo se llama con las dos. Si el titulo ya trae
 * extension, se respeta. Se conservan las letras acentuadas: son parte del
 * nombre real del archivo.
 */
function nombreArchivo(titulo, extension = "") {
	// Meta a veces pone de etiqueta "Descargar PDF de Prueba": no es parte del
	// nombre del archivo.
	const limpio = String(titulo || "").trim().replace(/^descargar\s+/i, "");
	const n = limpio.replace(/[\\/]+/g, "_").replace(/[^\p{L}\p{N}._\-+ ]/gu, "").trim();
	const ext = String(extension || "").replace(/^\./, "").replace(/[^\w]/g, "");
	if (!n) return ext ? `archivo.${ext}` : "archivo";
	if (!ext) return n;
	const extDelNombre = path.extname(n).replace(/^\./, "").toLowerCase();
	if (!extDelNombre) return `${n}.${ext}`;
	return n;
}

/**
 * Baja el archivo desde el sandbox de artefactos de meta.
 *
 * La url de meta sirve una PAGINA (el visor del archivo); los bytes crudos
 * salen pidiendo download=1. La url lleva su propio hash, asi que el archivo
 * se baja sin sesion.
 */
async function bajarArtefacto(url, destino, { timeoutMs = 120_000 } = {}) {
	try {
		const u = new URL(url);
		u.searchParams.set("download", "1");
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const r = await fetch(u, { headers: { "user-agent": UA }, signal: ctrl.signal, redirect: "follow" });
		clearTimeout(timer);
		if (!r.ok) return null;
		const tipo = String(r.headers.get("content-type") || "");
		// El visor responde HTML: eso no es el archivo.
		if (/^text\/html/i.test(tipo)) return null;
		const buf = Buffer.from(await r.arrayBuffer());
		if (!buf.length) return null;
		fs.writeFileSync(destino, buf);
		return { bytes: buf.length, tipo };
	} catch {
		return null;
	}
}

/**
 * Tipo REAL de un archivo, deducido de sus bytes (no de su extension).
 *
 * @param {string} abs ruta absoluta del archivo
 * @returns {{ext: string, mime: string, familia: string}}
 */
export function detectarTipo(abs) {
	let b = Buffer.alloc(0);
	try {
		const fd = fs.openSync(abs, "r");
		b = Buffer.alloc(4096);
		const n = fs.readSync(fd, b, 0, 4096, 0);
		fs.closeSync(fd);
		b = b.subarray(0, n);
	} catch { /* no se pudo leer */ }
	const txt = b.toString("latin1");
	if (txt.startsWith("%PDF-")) return { ext: "pdf", mime: "application/pdf", familia: "pdf" };
	if (b[0] === 0x89 && txt.slice(1, 4) === "PNG") return { ext: "png", mime: "image/png", familia: "imagen" };
	if (b[0] === 0xff && b[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg", familia: "imagen" };
	if (txt.startsWith("GIF8")) return { ext: "gif", mime: "image/gif", familia: "imagen" };
	if (txt.startsWith("RIFF") && txt.slice(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp", familia: "imagen" };
	if (b[0] === 0x50 && b[1] === 0x4b) {
		// OOXML (docx/xlsx/pptx) y zip: se distinguen por la carpeta interna
		// que aparece en las cabeceras del zip (word/, xl/, ppt/).
		if (txt.includes("word/")) return { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", familia: "ooxml" };
		if (txt.includes("xl/")) return { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", familia: "ooxml" };
		if (txt.includes("ppt/")) return { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", familia: "ooxml" };
		return { ext: "zip", mime: "application/zip", familia: "zip" };
	}
	if (b.length && !b.includes(0)) {
		const texto = b.toString("utf8");
		if (texto.trim().startsWith("{") || texto.trim().startsWith("[")) {
			return { ext: "json", mime: "application/json", familia: "json" };
		}
		return { ext: "txt", mime: "text/plain; charset=utf-8", familia: "texto" };
	}
	return { ext: "bin", mime: "application/octet-stream", familia: "binario" };
}

/** Familia a la que pertenece una extension. */
function familiaExt(ext) {
	const e = String(ext || "").toLowerCase().replace(/^\./, "");
	if (!e) return "";
	if (["pdf"].includes(e)) return "pdf";
	if (["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "odt", "ods", "odp"].includes(e)) return "ooxml";
	if (["zip"].includes(e)) return "zip";
	if (["csv", "tsv", "txt", "md"].includes(e)) return "texto";
	if (["json", "jsonl"].includes(e)) return "json";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "imagen";
	return "";
}

/**
 * Valida el archivo entregado contra su contenido y deja el nombre y el MIME
 * correctos. Si el contenido no es del tipo que dice la extension, manda el
 * contenido: el archivo se renombra con la extension real.
 *
 * @returns {{nombre: string, ruta: string, mime: string, bytes: number, corregido: boolean}}
 */
function validarArchivo(abs, nombre) {
	let bytes = 0;
	try { bytes = fs.statSync(abs).size; } catch { /* ignore */ }
	const real = detectarTipo(abs);
	const extNombre = path.extname(nombre).replace(/^\./, "").toLowerCase();
	const famNombre = familiaExt(extNombre);
	const famReal = real.familia;
	const textoOk = (famReal === "texto" || famReal === "json")
		&& (famNombre === "texto" || famNombre === "json" || famNombre === "");
	const compatible = !famNombre || !famReal || famNombre === famReal || textoOk;
	if (compatible) {
		return { nombre, ruta: abs, mime: mimeDeExtension(extNombre) ?? real.mime, bytes, corregido: false };
	}
	// El contenido es de otro tipo: se corrige el nombre (y el MIME) para no
	// entregar un archivo que se abre como si fuera otra cosa.
	const nuevo = path.basename(nombre, path.extname(nombre)) + "." + real.ext;
	let destino = abs;
	try {
		if (nuevo !== nombre) {
			destino = path.join(path.dirname(abs), nuevo);
			fs.renameSync(abs, destino);
		}
	} catch { /* si no se puede renombrar, se entrega con el nombre viejo */ }
	return { nombre: nuevo, ruta: destino, mime: real.mime, bytes, corregido: nuevo !== nombre };
}

/** MIME conocido por extension (los que no estan, se detectan por contenido). */
function mimeDeExtension(ext) {
	const M = {
		pdf: "application/pdf",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		csv: "text/csv; charset=utf-8",
		tsv: "text/tab-separated-values; charset=utf-8",
		txt: "text/plain; charset=utf-8",
		md: "text/markdown; charset=utf-8",
		json: "application/json",
		zip: "application/zip",
		html: "text/html; charset=utf-8",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
	};
	return M[String(ext || "").toLowerCase()] ?? null;
}

/**
 * Archivos que meta entrega con el CONTENIDO EN LINEA: su herramienta de
 * archivos responde con {archivo, contenido, ...} en el "value" del frame.
 * No hay script que reproducir ni url de descarga: si no se recoge aqui, el
 * archivo se pierde (medido 2026-11-02: un "genera un txt" respondio "Tu
 * archivo documento.txt esta creado" y no llego nada al cliente).
 *
 * @returns {Map<string, string>} nombre del archivo -> contenido
 */
function archivosEnLinea(frames) {
	const out = new Map();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		if (typeof o.archivo === "string" && typeof o.contenido === "string") {
			const nombre = path.basename(o.archivo.trim());
			// El mismo archivo viene repetido en todos los frames del turno:
			// se guarda el primero.
			if (nombre && o.contenido.length && !out.has(nombre)) out.set(nombre, o.contenido);
		}
		for (const v of Object.values(o)) walk(v);
	};
	walk(frames);
	return out;
}

/**
 * Codigo python que meta MUESTRA en la respuesta (bloque de codigo) y que
 * genera un archivo.
 *
 * Medido 2026-11-02: con las reglas de entrega, meta responde "Codigo Python
 * que lo genera con python-pptx" y el bloque va en la RESPUESTA (no en los
 * frames), asi que el espejo no lo veia y el archivo no llegaba al cliente.
 *
 * Solo se toman los bloques de python que ESCRIBEN un archivo: el resto no
 * produce nada que entregar.
 *
 * @returns {string[]}
 */
function codigoDeBloques(respuesta) {
	const out = [];
	for (const b of bloquesDe(respuesta || {})) {
		const lang = String(b.lang || "").toLowerCase();
		if (lang !== "python" && lang !== "py") continue;
		const c = String(b.code || "");
		if (c.length < 40) continue;
		// El bloque tiene que producir un archivo. No se busca una llamada
		// concreta: cada libreria guarda a su modo (openpyxl -> wb.save(),
		// python-pptx -> prs.save(), reportlab -> doc.build()) y quedarse con
		// un patron dejo fuera archivos que si se generaban (medido: un PDF
		// con reportlab nunca llego porque el filtro exigia .save()).
		// El nombre del archivo en el codigo es la senal de que produce uno.
		const produceArchivo = /[\w.-]+\.(?:pptx?|docx?|xlsx?|csv|tsv|pdf|zip|txt|md|html?|json|xml)\b/i.test(c);
		if (!produceArchivo) continue;
		out.push(c);
	}
	return out;
}

/**
 * Archivos que meta ANUNCIA en su respuesta pero NO entrega: su herramienta
 * interna crea un registro ({archivo, estado, tipo}) y no hay script, ni
 * contenido en linea, ni url de descarga. Medido 2026-11-02: "genera ppt"
 * respondio "PPT generado:" y solo dejo el registro -> el cliente se quedaba
 * sin archivo y SIN aviso (parecia que meta no habia generado nada).
 * Estos se devuelven como "pendientes": el cliente lo dice en voz alta.
 *
 * @returns {Array<{ruta:null, nombre:string, bytes:null, snapshot:null}>}
 */
function archivosAnunciados(...objetos) {
	const out = [];
	const vistos = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		// El que trae "contenido" lo materializa archivosEnLinea(): no es un
		// archivo perdido, es un archivo que hay que escribir.
		if (typeof o.archivo === "string" && !("contenido" in o)) {
			const nombre = path.basename(o.archivo.trim());
			if (nombre && !vistos.has(nombre)) {
				vistos.add(nombre);
				out.push({ ruta: null, nombre, bytes: null, snapshot: null });
			}
		}
		for (const v of Object.values(o)) walk(v);
	};
	for (const o of objetos) walk(o);
	return out;
}

/** Hash de un script: identifica si es el mismo que otro ya ejecutado. */
function shaDe(codigo) {
	return crypto.createHash("sha1").update(String(codigo ?? "")).digest("hex");
}

/** Dos nombres son el mismo archivo si coinciden sin extension ni mayusculas. */
function mismoArchivo(a, b) {
	const base = (x) => path.basename(String(x || ""))
		.replace(/\.[^.]+$/, "")
		.replace(/^descargar\s+/i, "")
		.trim().toLowerCase();
	const ba = base(a);
	const bb = base(b);
	return ba !== "" && ba === bb;
}

/** Dedup de artefactos por url (la respuesta y los frames los repite). */
function dedupeUrl(lista) {
	const vistos = new Set();
	const out = [];
	for (const a of lista) {
		const k = a?.url ?? a?.uuid;
		if (!k || vistos.has(k)) continue;
		vistos.add(k);
		out.push(a);
	}
	return out;
}

/**
 * Historial de los turnos ANTERIORES de un hilo: scripts ejecutados y
 * artefactos entregados.
 *
 * El sandbox de meta es por HILO: al pedir un archivo nuevo, meta reenvia
 * tambien las llamadas de herramienta y los artefactos de los turnos
 * anteriores. Si se procesaran todos, cada turno repetiria los archivos del
 * anterior (pedir un Word volvia a mostrar el PDF previo).
 *
 * Con el hash del script y el uuid del artefacto se sabe cual es cual: lo
 * IDENTICO a algo ya entregado es un reenvio y se salta.
 *
 * El historial vive en la carpeta del hilo DEL CLIENTE (estable), no en la de
 * la conversacion de meta: meta rota el id de conversacion entre turnos y el
 * historial se perdia (por eso se repetian los archivos).
 *
 * @returns {{scripts: Map<string, {archivos: string[]}>, artefactos: Map<string, {nombre: string}>, entregados: Map<string, {nombre: string, ruta: string|null, orden: number}>}}
 */
function historialPrevio(historialDir, turnoActual, historialLegacy = null) {
	const scripts = new Map();
	const artefactos = new Map();
	// Map (no Set): los cuerpos de los bucles de abajo usan entregados.set()
	// y el consumidor usa entregados.keys()/values() (nombre -> entrega).
	const entregados = new Map();
	if (!historialDir) return { scripts, artefactos, entregados };
	// El historial vive en el storage del canal; el legacy (.media/.hilo/<hash>)
	// se lee de respaldo para no perder el historial de los hilos ya vivos.
	// Las DOS carpetas: la del canal y la legacy. Se deduplican (si el legacy
	// apunta a la misma carpeta que la principal, se lee una sola vez).
	const dirs = [historialDir, historialLegacy].filter((d, i, a) => d && a.indexOf(d) === i);
	for (const dir of dirs) {
		let files = [];
		try { files = fs.readdirSync(dir); } catch { continue; }
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			if (f === `${turnoActual}.json`) continue;
			let man = null;
			try { man = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
			// Formato viejo (solo scripts, en array) y nuevo (scripts + artefactos).
			const listaScripts = Array.isArray(man) ? man : (man.scripts ?? []);
			const listaArts = Array.isArray(man) ? [] : (man.artefactos ?? []);
			const listaEntregados = Array.isArray(man) ? [] : (man.entregados ?? []);
			for (const item of listaScripts) {
				if (!item?.sha) continue;
				scripts.set(item.sha, { archivos: item.archivos ?? [] });
			}
			for (const item of listaArts) {
				if (!item?.uuid) continue;
				artefactos.set(item.uuid, { nombre: item.nombre ?? null });
			}
			for (const item of listaEntregados) {
				if (typeof item === "string") entregados.set(item, { nombre: item, ruta: null });
				else if (item?.nombre) entregados.set(item.nombre, { nombre: item.nombre, ruta: item.ruta ?? null, orden: item.orden ?? 0 });
			}
		}
	}
	return { scripts, artefactos, entregados };
}

/**
 * Busca un archivo YA entregado en este hilo con el mismo tipo (y a poder ser
 * el mismo nombre). Se usa cuando meta adjunta un artefacto con retraso: sus
 * bytes originales van a la carpeta del turno donde ese archivo ya se
 * anuncio, para que el enlace que el cliente ya tiene sirva el archivo real.
 */
function buscarEntregado(entregados, nombre) {
	const ext = path.extname(nombre).toLowerCase();
	const candidatos = [...entregados.values()]
		.filter((e) => e?.ruta && path.extname(e.nombre).toLowerCase() === ext);
	if (!candidatos.length) return null;
	// Primero el mismo nombre base; si no, el mas reciente.
	const mismo = candidatos.find((e) => mismoArchivo(e.nombre, nombre));
	if (mismo) return mismo;
	return candidatos.sort((a, b) => (b.orden ?? 0) - (a.orden ?? 0))[0];
}

/** Rutas /mnt/data/... que escribe un script. */
function rutasDelScript(codigo) {
	const out = new Set();
	const src = String(codigo ?? "");
	for (const m of src.matchAll(/["'`](\/mnt\/data\/[^"'`\s,)]+)/g)) {
		out.add(path.basename(m[1]));
	}
	// Guardados con ruta RELATIVA: prs.save("presentacion.pptx"),
	// open("datos.csv", "w"), Path("notas.txt").write_text(...). El codigo que
	// meta MUESTRA en la respuesta usa esta forma (no /mnt/data).
	for (const m of src.matchAll(/\.(?:save|write_text|write_bytes)\s*\(\s*["'`]([^"'`\n,)]+)["'`]/g)) {
		out.add(path.basename(m[1]));
	}
	for (const m of src.matchAll(/open\s*\(\s*["'`]([^"'`\n,)]+)["'`]\s*,\s*["'`]([wax])/g)) {
		out.add(path.basename(m[1]));
	}
	// El nombre del archivo en una variable ("filename = 'reporte.pdf'"): cada
	// libreria guarda a su modo y no siempre hay una llamada reconocible
	// (reportlab usa doc.build()).
	for (const m of src.matchAll(/["'`]([^"'`\n/]+\.(?:pptx?|docx?|xlsx?|csv|tsv|pdf|zip|txt|md|html?|json|xml))["'`]/gi)) {
		out.add(path.basename(m[1]));
	}
	return [...out];
}

/**
 * Dedup por ruta (o nombre si no hay ruta).
 * @param {Array} lista
 * @returns {Array}
 */
function dedupe(lista) {
	const vistos = new Set();
	const out = [];
	for (const x of lista) {
		const k = x?.ruta || x?.nombre;
		if (!k || vistos.has(k)) continue;
		vistos.add(k);
		out.push(x);
	}
	return out;
}

/**
 * Reproduce localmente los archivos que meta produjo en su sandbox.
 *
 * @param {object} opts
 * @param {Array} opts.frames frames crudos del stream (para el codigo)
 * @param {object} opts.respuesta respuesta acumulada
 * @param {string} opts.dir carpeta donde se materializa (bajo .media)
 * @param {string|null} opts.sandboxCache carpeta con el sandbox del hilo (cache
 *   del canal): lo que meta genero en un turno lo usa el script del siguiente
 * @returns {Promise<{archivos: Array, zip: object|null,.error: string|null, pendientes: Array}>}
 */
export async function materializar({ frames = [], respuesta = null, dir, convDir = null, historialDir = null, historialDirLegacy = null, sandboxCache = null, sandbox = true, timeoutMs = 120_000, adjuntos = [], modoAlmacen: modoArchivo = null } = {}) {
	const out = { archivos: [], zip: null, error: null, ejecucion: null, pendientes: [] };
	// El archivo que meta nombro puede aparecer en el TEXTO de la respuesta o
	// dentro del CODIGO que ejecuto (los frames): se buscan en los dos sitios,
	// que es donde "/mnt/data/..." aparece de verdad.
	// La galeria de imagenes se excluye: esas imagenes llegan por CDN y las
	// baja media.mjs, no son archivos perdidos.
	const mencionados = dedupe([...detectarArchivos(respuesta), ...detectarArchivos(frames)])
		.filter((x) => !String(x?.ruta || "").includes("/mnt/data/gallery/"));
	// Los artefactos del sandbox de meta (csv, json, markdown, documentos...):
	// traen su propia url de descarga. Se buscan en la respuesta Y en los
	// frames (meta los anuncia ahi, no siempre en el texto final).
	const artefactos = dedupeUrl([...artefactosMeta(respuesta), ...artefactosMeta(frames)]);
	if (!mencionados.length && !frames.length && !artefactos.length) return out;

	// Meta nombro estos archivos (/mnt/data/...). Si no se pueden reproducir
	// aqui, se devuelven como "pendientes" para que el cliente lo diga en voz
	// alta en vez de mostrar un turno sin rastro del archivo.
	out.pendientes = mencionados;

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	// Modo de entrega: "url" (sin copia en la API) o "local" (copia + /v1/media).
	// El ajuste del panel (engine/.ajustes.json) manda; si no se pasa, se usa
	// el valor por defecto (META_FILE_STORAGE).
	const modo = modoEntrega(modoArchivo);

	// (1) URL directa, si la hay
	const zipPath = path.join(dir, "sistema-agendamiento.zip");
	for (const url of buscarUrls(respuesta)) {
		// Modo "url": no hay copia en la API, se traspasa la URL tal cual.
		if (modo === "url") {
			let nombre = "archivo.zip";
			try { nombre = path.basename(new URL(url).pathname) || nombre; } catch { /* url sin forma */ }
			out.zip = { nombre, bytes: null, url, ruta: null };
			break;
		}
		const ok = await bajarUrl(url, zipPath);
		if (ok) {
			out.zip = { nombre: path.basename(zipPath), bytes: fs.statSync(zipPath).size, url: null, ruta: zipPath };
			break;
		}
	}

	// (1b) sandbox de artefactos de meta: se BAJA el archivo tal cual y se
	// deja en las carpetas LOCALES de la API (engine/.media/<conv>/), que es el
	// storage que sirve /v1/media. Esta es la via principal: no se ejecuta nada.
	//
	// Meta reenvia los artefactos de turnos anteriores (su sandbox es por hilo)
	// y a veces adjunta el artefacto de un archivo con UN TURNO de retraso. Los
	// que ya se entregaron se saltan, si no cada turno repite los archivos del
	// anterior (pedir un Word volvia a mostrar el PDF previo).
	const historial = historialPrevio(historialDir, path.basename(dir), historialDirLegacy);
	// Archivos que meta ANUNCIO pero no entrego (su herramienta interna creo el
	// registro y no hay bytes por ningun lado). Se anaden a los pendientes:
	// el cliente avisa "meta dijo que genero X pero no se pudo recuperar" en
	// vez de mostrar un turno sin archivo y sin aviso.
	const anunciados = archivosAnunciados(frames, respuesta)
		.filter((a) => ![...historial.entregados.keys()].some((n) => mismoArchivo(n, a.nombre)));
	for (const a of anunciados) {
		if (out.pendientes.some((p) => mismoArchivo(p?.nombre || "", a.nombre))) continue;
		out.pendientes.push(a);
	}
	// Nombres de archivos que meta REENVIO de un turno anterior (ya se
	// entregaron entonces: no se vuelven a listar).
	const reusados = new Set();
	// nombre -> ruta absoluta (lo que se bajo de meta en ESTE turno).
	const descargados = new Map();
	const artefactosVistos = [];

	// Los scripts que meta EJECUTO en su sandbox. Meta reenvia los de los turnos
	// anteriores (su sandbox es por hilo): un script IDENTICO a uno ya ejecutado
	// es un reenvio y se salta.
	const codigosTool = codigoDeHerramienta(frames);
	// Los scripts que meta MUESTRA en la respuesta (bloque de codigo) para que
	// el archivo se pueda reconstruir. NO se deduplican por hash: cada peticion
	// del usuario es un archivo nuevo (pedir "genera ppt" dos veces tiene que
	// entregar el pptx las dos veces).
	const codigosBloque = codigoDeBloques(respuesta);
	const codigos = [...new Set([...codigosTool, ...codigosBloque])];
	const scriptsNuevosTool = codigosTool.filter((c) => !historial.scripts.has(shaDe(c)));
	// Un bloque que es el MISMO codigo que una herramienta no se ejecuta dos
	// veces.
	const scriptsNuevosBloque = codigosBloque.filter((c) => !codigosTool.includes(c));
	const scriptsNuevos = [...scriptsNuevosTool, ...scriptsNuevosBloque];
	// Los scripts reenviados ya se entregaron en su turno: no se repiten (ni
	// como archivo, ni como "pendiente" del que avisar).
	const setNuevos = new Set(scriptsNuevos);
	for (const c of codigos) {
		if (setNuevos.has(c)) continue;
		for (const n of rutasDelScript(c)) reusados.add(n);
	}
	// Extensiones que producen los scripts NUEVOS de este turno.
	const extsNuevos = new Set();
	for (const c of scriptsNuevos) {
		for (const n of rutasDelScript(c)) {
			const e = path.extname(n).toLowerCase();
			if (e) extsNuevos.add(e);
		}
	}

	// Artefactos que se entregan con la URL de meta (modo "url"): la API no
	// guarda copia, el cliente baja directo de meta.
	const artefactosUrl = [];
	for (const a of artefactos) {
		const nombre = nombreArchivo(a.titulo, a.extension);
		const previo = a.uuid ? historial.artefactos.get(a.uuid) : null;
		const rutaPrevia = previo?.ruta ?? null;
		const ext = path.extname(nombre).toLowerCase();
		// (a) Ya se entrego en un turno anterior: mismo uuid o mismo nombre.
		const yaEntregado = (rutaPrevia && fs.existsSync(path.join(MEDIA_DIR, rutaPrevia)))
			|| [...historial.entregados.keys()].some((n) => mismoArchivo(n, nombre));
		// (b) Artefacto CON RETRASO: meta entrega el artefacto de un archivo
		//     en el turno SIGUIENTE (aparece en el stream antes de la llamada
		//     nueva). Si este turno uso la herramienta de codigo y el
		//     artefacto no corresponde a lo que produjo ese codigo, es de un
		//     turno anterior.
		const conRetraso = codigos.length > 0 && !extsNuevos.has(ext);
		// (c) MODO "url": no se baja el archivo. Se entrega la URL de meta.
		//     Si el artefacto ya se habia entregado (meta reenvia los de su
		//     sandbox, que es por hilo) no se vuelve a listar; si estaba
		//     PENDIENTE (anunciado y sin bytes), ahora se entrega su URL.
		if (modo === "url") {
			const url = urlDeDescarga(a.url);
			if (yaEntregado) {
				reusados.add(path.basename(rutaPrevia || nombre));
				artefactosVistos.push({ uuid: a.uuid ?? null, nombre, ruta: rutaPrevia ?? null, url });
				continue;
			}
			artefactosVistos.push({ uuid: a.uuid ?? null, nombre, ruta: null, url });
			artefactosUrl.push({ nombre, url, uuid: a.uuid ?? null });
			continue;
		}
		if (conRetraso) {
			// Se descarga IGUAL, pero a la carpeta del turno donde ese archivo
			// ya se anuncio: asi el enlace que el cliente ya tiene pasa a
			// servir los bytes ORIGINALES de meta (via externa, no espejo).
			const anterior = buscarEntregado(historial.entregados, nombre);
			if (anterior) {
				const ok = await bajarArtefacto(a.url, path.join(MEDIA_DIR, anterior.ruta));
				if (ok) {
					artefactosVistos.push({ uuid: a.uuid ?? null, nombre: anterior.nombre, ruta: anterior.ruta });
					reusados.add(path.basename(anterior.nombre));
					continue;
				}
			}
			reusados.add(path.basename(rutaPrevia || nombre));
			artefactosVistos.push({ uuid: a.uuid ?? null, nombre, ruta: rutaPrevia ?? null });
			continue;
		}
		if (yaEntregado) {
			reusados.add(path.basename(rutaPrevia || nombre));
			artefactosVistos.push({ uuid: a.uuid ?? null, nombre, ruta: rutaPrevia ?? null });
			continue;
		}
		const destino = path.join(dir, nombre);
		const ok = await bajarArtefacto(a.url, destino);
		const ruta = path.relative(MEDIA_DIR, destino).split(path.sep).join("/");
		artefactosVistos.push({ uuid: a.uuid ?? null, nombre, ruta: ok ? ruta : null });
		if (!ok) continue;
		descargados.set(nombre, destino);
	}

	// (2) reproducir los scripts que meta ejecuto en su sandbox
	//
	// ESPEJO FALLBACK: se usa cuando el archivo NO vino por enlace (meta lo
	// dejo solo en el sandbox de codigo).
	//
	// Ojo: el artefacto puede ser de un turno ANTERIOR (meta lo adjunta con
	// retraso), asi que la decision NO se toma solo con "hay algo descargado":
	// se ejecuta todo script NUEVO (los reenvios ya se filtraron arriba).
	//
	// Cuando hace falta, el espejo es FIEL: meta pudo ejecutar VARIOS scripts
	// (convertir un adjunto, crear el xlsx, ...). Se ejecutan TODOS, en el
	// orden en que llegaron, y se entregan los archivos que produjo cada uno
	// con su tipo original (un .xlsx sigue siendo .xlsx, un .csv sigue siendo
	// .csv). Ejecutar solo uno entregaba el archivo equivocado.
	// Nombres de los adjuntos recreados en el sandbox del espejo: son ENTRADAS,
	// no archivos generados, asi que no se listan como entregables.
	const nombresAdjuntos = new Set();
	// Los scripts se guardan en una carpeta oculta: son internos (el cliente no
	// los necesita) y la carpeta del turno es la que se sirve.
	const dirScripts = path.join(dir, ".scripts");
	fs.mkdirSync(dirScripts, { recursive: true, mode: 0o700 });
	const manifiesto = [];
	// (A/B) SANDBOX DEL TURNO y SANDBOX DEL HILO.
	//
	// El sandbox de meta es POR HILO: lo que genero en un turno lo usa el
	// script del turno siguiente (las imagenes de fondo del .pptx, el .png del
	// grafico). Se guarda una copia en la carpeta del canal (.sandbox-cache) y
	// cada turno parte de esa copia.
	const sandboxDir = path.join(dir, ".sandbox");
	// El cache vive FUERA del sandbox del turno: si no, la copia se meteria en
	// si misma.
	const cacheDir = sandboxCache && !sandboxCache.startsWith(sandboxDir + path.sep)
		? sandboxCache
		: null;
	// Los recursos del sandbox de meta (las imagenes que genero): se bajan del
	// CDN con su nombre ORIGINAL para que el script las encuentre donde las
	// busca.
	const recursos = recursosDe(frames);
	// Archivos que meta creo con su herramienta de archivos: trae el CONTENIDO
	// en el frame (no hay script ni url de descarga).
	const enLinea = archivosEnLinea(frames);
	// ENTADAS: lo que YA estaba antes de que corrieran los scripts de este
	// turno (lo que trajo el cache del hilo y lo que se bajo del CDN). Se
	// anotan con su mtime para distinguirlas de lo que produzcan los scripts
	// de ESTE turno (que las reescriben y por lo tanto cambian de mtime).
	// rel (relativo al sandbox) -> mtimeMs con el que quedo.
	const entradas = new Map();
	// Instante de la copia del cache: lo copiado tiene mtime anterior y lo
	// que escriban los scripts, posterior.
	let instanteCopia = 0;
	// Un archivo del sandbox es PRODUCCION de este turno si no es una entrada
	// intacta: lo escribio (o reescribio) un script de este turno.
	const esProduccion = (rel, st) => {
		const entrada = entradas.get(rel);
		if (entrada === undefined) return true;
		return entrada > 0 ? st.mtimeMs !== entrada : st.mtimeMs > instanteCopia;
	};
	// ESPEJO FALLBACK: se usa cuando el archivo NO vino por enlace (meta lo
	// dejo solo en el sandbox de codigo).
	//
	// En modo "url" el espejo es aun mas austero: si meta ya entrego el
	// archivo con su enlace de descarga, NO se reproduce nada aqui. La API no
	// guarda copia: el cliente baja directo de meta. Solo se corre el espejo
	// si el script produce algun archivo que el enlace no cubre.
	const extsArtefactos = new Set(artefactos
		.map((a) => path.extname(nombreArchivo(a.titulo, a.extension)).toLowerCase())
		.filter(Boolean));
	const cubiertoPorEnlaces = (codigo) => {
		const salidas = rutasDelScript(codigo);
		if (!salidas.length) return false;
		return salidas.every((n) => extsArtefactos.has(path.extname(n).toLowerCase()));
	};
	const espejoSobra = modo === "url"
		&& extsArtefactos.size > 0
		&& scriptsNuevos.length > 0
		&& scriptsNuevos.every(cubiertoPorEnlaces);
	const correScripts = !out.zip && scriptsNuevos.length > 0 && !espejoSobra;
	if (correScripts || recursos.length || enLinea.size) {
		fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
		// (B1) Se copia el sandbox del hilo (cache del canal) al sandbox del
		// turno: lo que meta genero antes sigue disponible.
		if (cacheDir && correScripts) {
			for (const c of copiarArbol(cacheDir, sandboxDir)) {
				entradas.set(c.rel.split(path.sep).join("/"), c.mtimeMs);
			}
			// El instante se toma DESPUES de copiar: lo copiado tiene mtime
			// anterior a el y lo que escriban los scripts, posterior.
			instanteCopia = Date.now();
		}
		// (A) Los recursos del sandbox de meta (las imagenes que genero en un
		// turno anterior): se bajan del CDN con su nombre original para que el
		// script de este turno los encuentre donde los busca.
		for (const r of recursos) {
			const destino = await bajarRecurso(r.url, sandboxDir, r.nombre);
			if (!destino) continue;
			const rel = path.relative(sandboxDir, destino).split(path.sep).join("/");
			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(destino).mtimeMs; } catch { /* ignore */ }
			entradas.set(rel, mtimeMs);
		}
		// (A2) Los archivos que meta creo con su herramienta de archivos: el
		// contenido viene en el frame, asi que se escribe tal cual. Se dejan
		// en el sandbox del turno para que el inventario los entregue (con el
		// tipo validado por sus bytes).
		for (const [nombre, contenido] of enLinea) {
			// Si ya se entrego en un turno anterior no se repite: meta reenvia
			// el estado del archivo en cada turno.
			const yaEntregado = [...historial.entregados.values()]
				.some((e) => mismoArchivo(e.nombre, nombre));
			if (yaEntregado) continue;
			try {
				fs.writeFileSync(path.join(sandboxDir, nombre), contenido, { mode: 0o600 });
			} catch { /* sin permiso: el archivo no se entrega */ }
		}
	}
	if (correScripts) {
		// Modo de ejecucion:
		//   "sandbox" (default) -> agent/sandbox.js (bwrap/docker), con aislamiento.
		//   "local"             -> python del host, SIN aislamiento. Se usa cuando el
		//                          sandbox no puede arrancar (bwrap sin capabilities:
		//                          "RTM_NEWADDR: Operation not permitted").
		// En los dos casos la salida cae en las carpetas LOCALES de la API
		// (engine/.media/<conv>/), que es el storage que sirve /v1/media.
		const modoEjec = String(process.env.META_ARTIFACT_EXEC || (sandbox ? "sandbox" : "local")).toLowerCase();

		// (C) Shim de los helpers de meta: sus scripts importan
		// render_helpers.py de SU sandbox, que aqui no existe. Se escribe una
		// vez por turno y el codigo del script se apunta a el.
		const rutaShim = escribirShimHelpers(sandboxDir);

		// Los adjuntos que subimos a meta tambien existen en SU sandbox
		// (/mnt/data/adjunto-1.pdf). Se recrean aqui con el mismo nombre para
		// que el script que escribio meta los pueda leer: sin esto, un script
		// que procesa el PDF adjunto no se puede reproducir.
		for (let i = 0; i < (adjuntos?.length ?? 0); i++) {
			const a = adjuntos[i];
			let leido = null;
			try { leido = await bytesDeAdjunto(a?.data); } catch { leido = null; }
			if (!leido?.buf?.length) continue;
			const nombre = `adjunto-${i + 1}${extensionDeMime(leido.mime, a?.data)}`;
			try {
				fs.writeFileSync(path.join(sandboxDir, nombre), leido.buf, { mode: 0o600 });
				nombresAdjuntos.add(nombre);
			} catch { /* sin adjunto: el script fallara y se dira */ }
		}

		const salidas = [];
		let fallo = null;
		for (let i = 0; i < scriptsNuevos.length; i++) {
			const original = scriptsNuevos[i];
			const sha = shaDe(original);
			const nombreScript = i === 0 ? "herramienta.py" : `herramienta-${i + 1}.py`;

			// El codigo de meta apunta a SU sandbox (/mnt/data) y a SUS helpers
			// (/home/code-interpreter/...): las dos rutas se apuntan a las
			// locales (el sandbox del turno y el shim de helpers).
			//
			// La ruta del helper se cambia dentro de sus comillas (para no
			// romper el codigo) y, si aparece suelta, se cambia igual.
			const codigo = original
				.replaceAll("/mnt/data/", `${sandboxDir}/`)
				.replaceAll(`"${RUTA_HELPERS_META}"`, JSON.stringify(rutaShim))
				.replaceAll(`'${RUTA_HELPERS_META}'`, `'${rutaShim}'`)
				.replaceAll(RUTA_HELPERS_META, rutaShim);
			const script = path.join(dirScripts, nombreScript);
			fs.writeFileSync(script, codigo, { mode: 0o600 });

			let res;
			if (modoEjec === "local") {
				// El cwd es el sandbox del turno: un script que guarde con ruta
				// RELATIVA ("prs.save('presentacion.pptx')") deja el archivo
				// donde el inventario lo busca.
				const r = await ejecutarLocal(script, { cwd: sandboxDir, timeoutMs, maxOutputBytes: 64 * 1024 });
				res = { ok: r.ok, denied: false, output: r.salida, error: r.error };
			} else {
				res = await runSandboxed(`python3 ${JSON.stringify(script)}`, {
					workdir: sandboxDir,
					allowWrite: true,
					allowNetwork: false,
					timeoutMs,
					maxOutputBytes: 64 * 1024,
				});
			}
			salidas.push({
				script: nombreScript,
				ok: !!res.ok,
				denied: !!res.denied,
				salida: String(res.output ?? "").slice(-500),
			});
			manifiesto.push({
				sha,
				// La ruta del archivo copiado a la raiz del turno (esa es la
				// que se sirve). El script escribe en sandbox/, pero el archivo
				// final vive en la raiz del turno.
				archivos: rutasDelScript(original)
					.map((n) => path.relative(MEDIA_DIR, path.join(dir, n)).split(path.sep).join("/")),
			});
			if (!res.ok && !res.denied) fallo = res.error ?? "la herramienta fallo";
			// NO se corta el ciclo aqui: cuando meta escribe un script con un
			// error, el modelo lo corrige y manda OTRO script (el bueno). Si se
			// paraba en el primer fallo, ese script nunca corria y el archivo
			// se perdia (pasó con un .pptx: el primer script fallaba al poner
			// un color y el segundo lo hacia bien).
		}
		out.ejecucion = { modo: modoEjec, scripts: salidas };
		// El error solo se avisa si NO se produjo ningun archivo: si el script
		// corregido funciono, el turno esta bien. Lo que cuenta es lo que
		// escribieron los scripts de ESTE turno (el sandbox del hilo ya tenia
		// archivos: no son de este turno).
		let produjo = false;
		for (const f of listar(sandboxDir)) {
			let st;
			try { st = fs.statSync(path.join(sandboxDir, f)); } catch { continue; }
			if (esProduccion(f.split(path.sep).join("/"), st)) { produjo = true; break; }
		}
		if (fallo && !produjo) out.error = fallo;

		// lo que produjo queda en sandboxDir
		const zips = listar(sandboxDir).filter((f) => f.endsWith(".zip"));
		if (zips.length) {
			const mejor = zips.map((f) => path.join(sandboxDir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
			const destino = path.join(dir, path.basename(mejor));
			if (mejor !== destino) fs.copyFileSync(mejor, destino);
			out.zip = { nombre: path.basename(destino), bytes: fs.statSync(destino).size, ruta: destino };
		}
	}

	// (B2) Se guarda el sandbox del turno en el cache del hilo: el siguiente
	// turno del hilo parte de aqui (es lo que hace meta en su sandbox, que es
	// por hilo). La carpeta de helpers es interna: no se copia.
	if (cacheDir && fs.existsSync(sandboxDir)) {
		try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
		copiarArbol(sandboxDir, cacheDir, (n) => n === ".helpers" || n === "__pycache__");
	}

	// (3) inventario final de lo materializado
	//
	// Solo se listan los archivos que materializo ESTE turno. La carpeta del
	// turno la comparten con las imagenes que ya bajo media.mjs (y con el
	// indice .index.json): una imagen no es un "archivo" pendiente, ya sale
	// como meta_images con su vista previa, y repetirla aqui hacia pensar
	// que hay un adjunto que no existe.
	const raizSandbox = path.join(dir, ".sandbox");
	// nombre -> ruta absoluta.
	const producidos = new Map();
	for (const [n, abs] of descargados) producidos.set(n, abs);
	// Si ya bajamos el archivo de meta en este turno, sus bytes son los de
	// meta: la copia del espejo es el MISMO archivo y no se lista (si no, el
	// turno muestra el pdf dos veces). El cruce es por nombre base y, cuando
	// hay una sola descarga, por extension (meta titula el artefacto distinto
	// que el script: "PDF de prueba" vs "pdf_prueba_titulo").
	const descargadosNombres = [...descargados.keys()];
	const esElMismo = (nombre) => descargadosNombres.some((n) => mismoArchivo(n, nombre))
		|| (descargadosNombres.length === 1
			&& path.extname(nombre).toLowerCase() === path.extname(descargadosNombres[0]).toLowerCase()
			&& path.extname(nombre) !== "");
	for (const f of listar(raizSandbox)) {
		const abs = path.join(raizSandbox, f);
		let st;
		try { st = fs.statSync(abs); } catch { continue; }
		if (!st.isFile()) continue;
		const nombre = path.basename(f);
		const rel = f.split(path.sep).join("/");
		// Los adjuntos son entradas: el cliente ya las tiene, no se listan.
		if (nombresAdjuntos.has(nombre)) continue;
		// Si el archivo ya se BAJO de meta, esos son sus bytes: no se pisan con
		// la copia del espejo.
		if (descargados.has(nombre)) continue;
		// Ya lo bajamos de meta en este turno (con otro nombre): no se duplica.
		if (esElMismo(nombre)) continue;
		// (A/B) Las ENTRADAS (lo que trajo el cache del hilo y lo que se bajo
		// del CDN de meta) NO son archivos de este turno: no se entregan de
		// nuevo, salvo que el script de este turno los reescriba (cambia el
		// mtime). Sin esto, el turno 2 volveria a entregar las imagenes del
		// turno 1.
		if (!esProduccion(rel, st)) continue;
		const destino = path.join(dir, nombre);
		try { if (abs !== destino) fs.copyFileSync(abs, destino); } catch { /* ignore */ }
		producidos.set(nombre, destino);
	}
	if (out.zip?.ruta) producidos.set(path.basename(out.zip.ruta), out.zip.ruta);
	// Cada archivo se VALIDA por su contenido: el MIME y la extension salen de
	// los bytes, no de lo que dijo meta. Si el contenido no corresponde, el
	// archivo se renombra con la extension real (un .txt que en realidad es un
	// pdf no se entrega como .txt).
	out.archivos = [...producidos.entries()].map(([nombre, abs]) => {
		const v = validarArchivo(abs, nombre);
		return {
			nombre: v.nombre,
			ruta: path.relative(dir, v.ruta) || v.nombre,
			bytes: v.bytes,
			mime: v.mime,
			// Relativa a .media (la raiz que sirve /v1/media), NO a la carpeta
			// del turno: si no, falta el <convId>/ y el enlace da 404.
			url: `/v1/media/${path.relative(MEDIA_DIR, v.ruta).split(path.sep).join("/")}`,
		};
	});
	// (C) Modo "url": los artefactos de meta van con SU url de descarga. El
	// cliente baja DIRECTO de meta y la API no guarda copia de nada.
	if (artefactosUrl.length) {
		// Si el espejo genero un archivo del MISMO nombre (o de la misma
		// extension, cuando hay un solo artefacto), manda el original de meta.
		const nombresUrl = new Set(artefactosUrl.map((a) => a.nombre));
		const extsUrl = new Set(artefactosUrl.map((a) => path.extname(a.nombre).toLowerCase()).filter(Boolean));
		out.archivos = out.archivos.filter((a) => {
			if (nombresUrl.has(a.nombre)) return false;
			if (artefactosUrl.length === 1 && extsUrl.has(path.extname(a.nombre).toLowerCase())) return false;
			return true;
		});
		for (const e of artefactosUrl) {
			out.archivos.push({
				nombre: e.nombre,
				ruta: null,
				bytes: null,
				mime: mimeDeExtension(path.extname(e.nombre).replace(/^\./, "")) ?? "application/octet-stream",
				url: e.url,
			});
		}
	}
	// El zip local (modo "local") toma la url que se le dio al servirlo.
	if (out.zip && out.zip.ruta) out.zip.url = out.archivos.find((a) => a.nombre === out.zip.nombre)?.url ?? null;
	// Lo que se reprodujo aqui ya NO esta pendiente: si no, el cliente recibe
	// el archivo Y un aviso de "no se pudo recuperar" a la vez. Tambien lo que
	// meta reenvio de un turno anterior (ya se entrego entonces).
	//
	// El nombre del artefacto y el que meta nombra en su script suelen diferir
	// ("PDF de prueba con titulo.pdf" vs "pdf_prueba_titulo.pdf"): son el
	// MISMO archivo, asi que el pendiente se cruza por extension.
	if (out.pendientes.length) {
		const entregados = new Set(out.archivos.map((a) => a.nombre));
		const exts = new Set(out.archivos.map((a) => path.extname(a.nombre).toLowerCase()).filter(Boolean));
		out.pendientes = out.pendientes.filter((p) => {
			const n = path.basename(String(p?.ruta || p?.nombre || ""));
			if (entregados.has(n) || reusados.has(n)) return false;
			return !exts.has(path.extname(n).toLowerCase());
		});
	}

	// El manifiesto se escribe SIEMPRE (tambien cuando no hubo scripts): dice
	// que se entrego en este turno, para que los turnos siguientes reconozcan
	// los reenvios de meta y no repitan los archivos. Vive en la carpeta del
	// hilo del cliente: meta puede rotar el id de conversacion entre turnos.
	try {
		const destinoManifiesto = historialDir
			? path.join(historialDir, `${path.basename(dir)}.json`)
			: path.join(dirScripts, "manifiesto.json");
		fs.mkdirSync(path.dirname(destinoManifiesto), { recursive: true, mode: 0o700 });
		fs.writeFileSync(destinoManifiesto, JSON.stringify({
			scripts: manifiesto,
			artefactos: artefactosVistos,
			// Con la ruta (relativa a .media) para poder replacecer despues los
			// bytes por los originales de meta cuando llegue su artefacto. En
			// modo "url" no hay ruta local: se guarda la url de meta, para que
			// los turnos siguientes reconozcan el archivo sin volver a bajarlo.
			entregados: out.archivos.map((a) => ({
				nombre: a.nombre,
				ruta: String(a.url || "").startsWith("/v1/media/")
					? String(a.url).replace(/^\/v1\/media\//, "")
					: null,
				url: String(a.url || "").startsWith("/v1/media/") ? null : String(a.url || ""),
				orden: Date.now(),
			})),
		}, null, 1), { mode: 0o600 });
	} catch { /* el manifiesto es opcional */ }
	return out;
}
