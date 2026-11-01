// sdd-loop.mjs — Meta entrega un sistema de agendamiento (SDD completo, con
// esquemas y mock) empaquetado en un ZIP; este script lo baja, lo audita y
// le pide a Meta CORRECCIONES pontuales.
//
//   node engine/sdd-loop.mjs [--rondas 8] [--dest /tmp/opencode/sdd]
//                            [--usuario sdd] [--canal dev]
//
// El encargo:
//   1. pedirle a Meta el proyecto completo (specs, design, tasks, codigo,
//      ESQUEMAS y MOCK) empaquetado en un zip
//   2. BAJAR el zip (URL directa, base64, o generador que lo produce)
//   3. auditarlo (estructura SDD, sintaxis, pruebas, arranque, secretos)
//   4. si falla: se le manda a Meta el ERROR EXACTO + solo el fragmento
//      implicado, y se le pide un PARCHE (unified diff). Nunca el archivo
//      completo.
//
// Por que un "generador" y no un adjunto binario: este gateway solo expone
// GenAIImagePrimitive (imagenes) y GenAICodeUXPrimitive (codigo). Meta no
// puede adjuntar un .zip binario aqui; lo que si puede hacer es entregar el
// proyecto como codigo (o base64) que aqui se convierte en un zip de verdad.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { MetaEngine } from "./broker-engine.mjs";
import { auditar } from "./auditar-proyecto.mjs";
import { extraerCodigo } from "./codigo.mjs";
import { REGLAS_CODIGO } from "./prompts.mjs";
import { evento } from "./eventos.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const RONDAS = Number(arg("--rondas", 8));
const BASE = path.resolve(arg("--dest", "/tmp/opencode/sdd"));
const USUARIO = arg("--usuario", "sdd");
const CANAL = arg("--canal", "dev");

const WORK = path.join(BASE, `w-${Date.now()}`);
const PROY = path.join(WORK, "proyecto");
fs.mkdirSync(WORK, { recursive: true });

const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ======================= 1. EL PEDIDO =======================
// El prompt que dio el usuario: sistema de agendamiento, modelo de tareas,
// SDD completo, con esquemas y mock, entregado en un zip.
const PEDIDO = [
	"Necesito un SISTEMA DE AGENDAMIENTO DE TAREAS completo, developed con Spec-Driven Development (SDD) y entregado como un unico archivo ZIP.",
	"",
	"COMO ME LO ENTREGAS (obligatorio, leelo bien):",
	"- Entregame el CODIGO de cada archivo en bloques de codigo, en el mensaje.",
	"- Antes de cada archivo, en una linea aparte, escribi el marcador: ### FILE: ruta/del/archivo",
	"- Todos los archivos vanfollowed en el MISMO bloque de codigo, en orden, y completos. No omitas archivos, no digas '...' y no digas 'continuara'.",
	"- No me lo renderices como artefacto con el icono \"<\"> ni como visor: yo solo leo los bloques de codigo del mensaje.",
	"- Si el proyecto es muy largo, entrega primero los archivos de codigo (src/ y tests/) en el bloque, y despues la documentacion en otro bloque, cada uno con sus marcadores ### FILE:.",
	"",
	"EL PROYECTO (`sistema-agendamiento/`) debe contener:",
	"",
	"1) SDD (documentacion, obligatoria):",
	"   - README.md (que es, como se corre, endpoints, como se prueba, decisiones)",
	"   - specs/spec.md con requisitos RF-01, RF-02... y specs/scenarios.md con escenarios Given/When/Then",
	"   - design/design.md (arquitectura, modelo de datos, flujo) y design/adr/0001-*.md, 0002-*.md (al menos 2 ADRs)",
	"   - tasks/tasks.md (plan con checkboxes)",
	"",
	"2) MODELO DE TAREAS (src/model.py): Task con id, titulo, descripcion, estado, prioridad, fecha_limite, dependencias, etiquetas, creada_en, actualizada_en; transiciones de estado validas (pendiente -> en_progreso -> completada/fallida, y cancelada desde cualquier estado); validacion de entradas.",
	"",
	"3) ESQUEMAS (obligatorios, en texto y en codigo):",
	"   - el esquema SQL/DDL completo de la base (tablas, columnas, tipos, claves primarias y foraneas, indices, restricciones)",
	"   - un esquema de la API (endpoints, metodo, request, response, codigos de error)",
	"   - ambos como artefactos de texto: specs/esquema-db.md y specs/esquema-api.md",
	"",
	"4) MOCK (obligatorio, para poder correr sin dependencias externas):",
	"   - datos mock iniciales (tareas de ejemplo, usuarios, calendario) en src/mock.py, cargables con un flag (--mock / MOCK=1)",
	"   - mock del proveedor de tiempo/horario y del envio de notificaciones, para que el planificador sea determinista y testeable",
	"   - fixtures mock para las pruebas",
	"",
	"5) PERSISTENCIA (src/store.py): sqlite, creacion de esquema, indices, migracion simple.",
	"6) PLANIFICADOR (src/scheduler.py): cola, reintentos con backoff, idempotencia, cancelacion, y modo mock que no depende del reloj real.",
	"7) API HTTP (src/api.py): solo http.server de la stdlib. GET /health, GET/POST /tasks, GET/PATCH/DELETE /tasks/{id}, POST /tasks/{id}/run. Validacion de entrada y errores en JSON.",
	"8) CLI (src/cli.py): crear/listar/completar tareas, y sembrar los mocks.",
	"9) PRUEBAS (tests/test_*.py): unittest sin dependencias externas: modelo y transiciones, store, API, scheduler (con reloj mock).",
	"10) run.sh (levanta la API), test.sh (corre las pruebas), requirements.txt (vacio o solo comentario).",
	"",
	"Empieza ya. Todos los archivos con su marcador ### FILE:.",
].join("\n");

// ======================= 2. RECIBIR EL CODIGO =======================

/**
 * Convierte la respuesta de meta en archivos.
 *
 * Formato pedido: el bloque de codigo lleva marcadores "### FILE: ruta" antes
 * de cada archivo. Se acepta tambien un bloque por archivo (el ultimo bloque
 * gana si se repite una ruta).
 * @returns {Array<{ruta:string, codigo:string}>}
 */
export function archivosDeCodigo(bloques) {
	const out = [];
	for (const b of bloques ?? []) {
		const texto = b.code ?? "";
		if (!/###\s*FILE:/i.test(texto)) continue;
		const partes = texto.split(/^###\s*FILE:\s*(.+)$/im);
		// partes: [pre, ruta1, cuerpo1, ruta2, cuerpo2, ...]
		for (let i = 1; i + 1 < partes.length; i += 2) {
			const ruta = partes[i].trim().replace(/^`+|`+$/g, "");
			const codigo = partes[i + 1].replace(/^\n+/, "");
			if (ruta && codigo.trim()) out.push({ ruta, codigo });
		}
	}
	return out;
}

/** Escribe los archivos del proyecto (respeta la ruta dentro del proyecto). */
export function escribirArchivos(archivos, raiz) {
	const escritos = [];
	for (const { ruta, codigo } of archivos) {
		const limpio = ruta.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
		if (!limpio || limpio.includes("..")) continue;
		const destino = path.join(raiz, limpio);
		if (!destino.startsWith(raiz + path.sep)) continue;
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, codigo);
		escritos.push(limpio);
	}
	return escritos;
}

// ======================= 3. BAJAR EL ZIP =======================
/** URLs que parezcan un archivo descargable (fbcdn, .zip, etc). */
function buscarUrls(respuesta) {
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

/** Bloques base64 largos (posible zip embebido). */
function buscarBase64(respuesta) {
	const out = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const v of Object.values(o)) {
			if (typeof v === "string") {
				const m = v.match(/[A-Za-z0-9+/]{1200,}={0,2}/g);
				if (m) out.push(...m);
			} else walk(v);
		}
	};
	walk(respuesta);
	return out.sort((a, b) => b.length - a.length);
}

/**
 * Meta tiene un SANDBOX de archivos: cuando usa su herramienta de python, los
 * archivos quedan en /mnt/data/... y la respuesta trae file_path +
 * snapshot_handle + snapshot_id. Se buscan esas pistas para saber que hay que
 * bajar (y con que endpoint).
 */
function buscarArchivos(respuesta) {
	const out = [];
	const walk = (o, path = "") => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o)) {
			const p = `${path}/${k}`;
			if (typeof v === "string") {
				if (v.startsWith("/mnt/data/")) out.push({ tipo: "file_path", valor: v, donde: p });
				else if (/\.(zip|tar\.gz|tgz)\b/i.test(v) && v.length < 400) out.push({ tipo: "nombre_zip", valor: v, donde: p });
			} else if (v && typeof v === "object") {
				if (v.snapshot_handle) out.push({ tipo: "snapshot", valor: v.snapshot_handle, id: v.snapshot_id ?? null, donde: p });
				walk(v, p);
			}
		}
	};
	walk(respuesta);
	return out;
}

const esZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);

/** Descarga una URL y la guarda; devuelve la ruta si es un zip valido. */
async function bajarUrl(url, destino) {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 120_000);
		const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal, redirect: "follow" });
		clearTimeout(timer);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const buf = Buffer.from(await r.arrayBuffer());
		if (!esZip(buf)) throw new Error(`no es un zip (magic ${buf.subarray(0, 4).toString("hex")}, ${buf.length} bytes)`);
		fs.writeFileSync(destino, buf);
		return destino;
	} catch (err) {
		log(`  url no servia: ${String(err.message).slice(0, 140)}`);
		return null;
	}
}

/** Compila python para saber si el texto es un script valido. */
async function compilaPython(ruta) {
	try {
		await execFileAsync("python3", ["-m", "py_compile", ruta], { timeout: 60_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Codigo de la HERRAMIENTA de python de meta: llega en frames[].code (no como
 * GenAICodeUXPrimitive). Meta lo ejecuta en su sandbox (/mnt/data/...) y por eso
 * el zip existe alla. Aqui se ejecuta el MISMO script en local: reproduce el
 * zip byte a byte.
 */
function codigoDeHerramienta(frames) {
	const codigos = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o)) {
			if (k === "code" && typeof v === "string" && v.length > 200) codigos.push(v);
			else if (v && typeof v === "object") walk(v);
		}
	};
	walk(frames);
	return codigos;
}

/**
 * Convierte lo que devolvio Meta en un zip real en disco.
 * Orden: (1) URL descargable, (2) base64, (3) script que meta ejecuto en su
 * sandbox, (4) bloque de codigo generico.
 */
async function bajarZip(jsons, respuesta, work, log) {
	const zipPath = path.join(work, "sistema-agendamiento.zip");

	// --- (0) pistas del sandbox de archivos de meta ---
	const archivos = buscarArchivos(respuesta);
	if (archivos.length) {
		for (const a of archivos.slice(0, 8)) log(`  sandbox: ${a.tipo} ${String(a.valor).slice(0, 90)} (${a.donde})`);
	}

	// --- (1) URL directa ---
	for (const url of buscarUrls(respuesta)) {
		log(`  probando url de archivo: ${url.slice(0, 110)}`);
		const ok = await bajarUrl(url, zipPath);
		if (ok) return { zip: ok, como: "url directa" };
	}

	// --- (2) base64 ---
	for (const b64 of buscarBase64(respuesta).slice(0, 3)) {
		try {
			const buf = Buffer.from(b64, "base64");
			if (esZip(buf)) {
				fs.writeFileSync(zipPath, buf);
				return { zip: zipPath, como: "base64 embebido" };
			}
		} catch { /* no era base64 */ }
	}

	// --- (3) script que meta ejecuto en su sandbox (frames[].code) ---
	const deHerramienta = codigoDeHerramienta(jsons);
	if (deHerramienta.length) log(`  codigo de herramienta: ${deHerramienta.length} bloque(s) (${deHerramienta.map((c) => c.length).join(", ")} chars)`);

	// --- (4) bloques de codigo del mensaje ---
	const bloques = extraerCodigo(jsons, respuesta);
	log(`  bloques de codigo: ${bloques.length} (${bloques.map((b) => `${b.lang || "?"}:${b.code.length}`).join(", ")})`);

	const candidatos = [];
	for (const [i, c] of deHerramienta.entries()) {
		candidatos.push({ nombre: `herramienta-${i + 1}.py`, codigo: c });
	}
	if (bloques.length) {
		candidatos.push({ nombre: "generador.py", codigo: bloques.map((b) => b.code).join("\n") });
		for (const b of bloques) {
			candidatos.push({ nombre: `bloque-${(b.lang || "txt").replace(/[^a-z0-9]/gi, "")}.py`, codigo: b.code });
		}
	}
	if (!candidatos.length) return null;

	for (const c of candidatos) {
		const ruta = path.join(work, c.nombre);
		fs.writeFileSync(ruta, c.codigo);
		if (!(await compilaPython(ruta))) continue;
		log(`  ejecutando ${c.nombre} (${c.codigo.length} chars)`);
		// el script de meta apunta a /mnt/data (su sandbox): se redirige al
		// directorio de trabajo local para reproducir el zip aqui.
		const sandbox = path.join(work, "sandbox");
		fs.mkdirSync(sandbox, { recursive: true });
		const codigoLocal = c.codigo.replaceAll("/mnt/data/", `${sandbox}/`);
		const rutaLocal = path.join(work, `${c.nombre}.local`);
		fs.writeFileSync(rutaLocal, codigoLocal);
		try {
			await execFileAsync("python3", [rutaLocal], { cwd: work, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
		} catch (err) {
			log(`  el generador fallo: ${String(err.stderr || err.message).slice(0, 500)}`);
			continue;
		}
		// el zip puede estar en el work o en subcarpetas
		const candidatosZip = [];
		const recorrer = (dir) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) { if (e.name !== "__pycache__") recorrer(p); }
				else if (e.name.endsWith(".zip")) candidatosZip.push(p);
			}
		};
		recorrer(work);
		if (candidatosZip.length) {
			const mejor = candidatosZip.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
			if (mejor !== zipPath) fs.copyFileSync(mejor, zipPath);
			return { zip: zipPath, como: `generador (${c.nombre})` };
		}
		// no hizo zip pero escribio el arbol: se empaqueta aqui
		const arbol = fs.readdirSync(work).filter((f) => f !== c.nombre && !f.endsWith(".zip"));
		if (arbol.length) {
			log(`  el generador no creo zip pero escribio ${arbol.length} entradas: se empaqueta`);
			await execFileAsync("zip", ["-qr", zipPath, ...arbol], { cwd: work, timeout: 120_000 });
			return { zip: zipPath, como: `generador (${c.nombre}, zip armado aqui)` };
		}
	}
	return null;
}

// ======================= 3. AUDITAR =======================
function fragmentoDeError(archivo, salida) {
	// solo el fragmento implicado: nunca el archivo completo
	const ruta = path.join(PROY, archivo);
	if (!fs.existsSync(ruta)) return "";
	const lineas = fs.readFileSync(ruta, "utf8").split("\n");
	const numeros = [...String(salida).matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
	if (!numeros.length) return `\nPRIMERAS 40 LINEAS DE ${archivo}:\n${lineas.slice(0, 40).join("\n")}\n`;
	const set = new Set();
	for (const n of numeros) for (let i = n - 6; i <= n + 6; i++) if (i > 0) set.add(i);
	const idx = [...set].sort((a, b) => a - b);
	return `\nFRAGMENTO DE ${archivo} (lineas ${idx[0]}-${idx.at(-1)}):\n${idx.map((i) => `${i}: ${lineas[i - 1] ?? ""}`).join("\n")}\n`;
}

function promptParche(error, otros) {
	const e = error;
	return [
		"El proyecto que me entregaste tiene un error al ejecutarlo. Te paso el error EXACTO.",
		"NO me reenvies el archivo completo ni el proyecto entero: quiero SOLO un PARCHE.",
		"",
		"ERROR EXACTO:",
		`archivo: ${e.archivo}`,
		`comando: ${e.comando}`,
		"salida:",
		String(e.salida ?? "(sin salida)").slice(0, 2500),
		otros.length ? `\nOTROS FALLOS DETECTADOS:\n${otros.map((f) => `- ${f.archivo}: ${f.comando}`).join("\n")}\n` : "",
		fragmentoDeError(e.archivo, e.salida),
		"Responde SOLO con un parche en formato unified diff (--- a/<archivo> y +++ b/<archivo>) que corrija ese error. Sin explicaciones, sin el archivo completo.",
	].filter(Boolean).join("\n");
}

function extraerDiff(texto) {
	const m = texto.match(/```(?:diff|patch)?\n([\s\S]*?)```/) ?? texto.match(/(--- [^\n]+\n\+\+\+ [^\n]+\n[\s\S]*)/);
	return (m?.[1] ?? texto).trim();
}

function aplicarPatch(diff, cwd) {
	return new Promise((res, rej) => {
		const p = spawn("patch", ["-p0", "--forward", "--batch"], { cwd });
		let out = "";
		p.stdout.on("data", (d) => { out += d.toString(); });
		p.stderr.on("data", (d) => { out += d.toString(); });
		p.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`patch fallo (${code}): ${out.slice(0, 400)}`))));
		p.stdin.write(diff);
		p.stdin.end();
	});
}

function unzip(zipPath, destino) {
	return execFileAsync("unzip", ["-o", zipPath, "-d", destino], { timeout: 120_000 });
}

// ======================= 4. LOOP =======================
const engine = new MetaEngine({ mode: "session" });
const informe = [];

log(`destino: ${WORK}`);
log("pidiendo a Meta el sistema de agendamiento (SDD + esquemas + mock + zip)…");

const jsons = [];
let r = await engine.ask(PEDIDO, {
	userId: USUARIO, channel: CANAL,
	onJson: (j) => jsons.push(j),
	watchdogMs: 20_000, watchdogPrompt: "continua",
});
if (r.nudge) log(`watchdog: meta se callo ${Math.round(r.nudge.ms / 1000)}s -> "continua"`);

log("buscando el codigo en la respuesta…");
fs.writeFileSync(path.join(WORK, "respuesta-meta.json"), JSON.stringify(r.response ?? null, null, 1));
fs.writeFileSync(path.join(WORK, "frames-meta.json"), JSON.stringify(jsons, null, 1));

// --- 1) codigo con marcadores ### FILE: (lo que se pide a meta) ---
fs.mkdirSync(PROY, { recursive: true });
let RAIZ = PROY;
let archivos = archivosDeCodigo(extraerCodigo(jsons, r.response));
let escritos = escribirArchivos(archivos, RAIZ);
log(`archivos recibidos: ${escritos.length}${escritos.length ? ` (${escritos.slice(0, 6).join(", ")}${escritos.length > 6 ? "…" : ""})` : ""}`);

if (!escritos.length) {
	log("meta no entrego codigo con marcadores: se le repregunta");
	const r2 = await engine.ask(PEDIDO + "\n\nIMPORTANTE: responde con los bloques de codigo, cada archivo con su linea '### FILE: ruta' antes del codigo.", {
		userId: USUARIO, channel: CANAL, onJson: (j) => jsons.push(j), watchdogMs: 20_000, watchdogPrompt: "continua",
	});
	archivos = archivosDeCodigo(extraerCodigo(jsons, r2.response));
	escritos = escribirArchivos(archivos, RAIZ);
	log(`archivos recibidos (2o intento): ${escritos.length}`);
}

// --- 2) zip del sandbox (meta lo genera con su herramienta de python) ---
let bajada = null;
if (!escritos.length) {
	bajada = await bajarZip(jsons, r.response, WORK, log);
	if (!bajada) {
		log("NO se pudo obtener el proyecto: meta no entrego nada utilizable");
		process.exit(2);
	}
	log(`zip bajado (${bajada.como}): ${bajada.zip} (${fs.statSync(bajada.zip).size} bytes)`);
	evento("SDD_ZIP_BAJADO", { como: bajada.como, bytes: fs.statSync(bajada.zip).size });
	await unzip(bajada.zip, PROY);
	const entradas = fs.readdirSync(PROY);
	if (entradas.length === 1 && fs.statSync(path.join(PROY, entradas[0])).isDirectory()) {
		RAIZ = path.join(PROY, entradas[0]);
	}
} else {
	evento("SDD_CODIGO", { archivos: escritos.length });
}

log(`proyecto implementado en: ${RAIZ}`);
evento("SDD_ENTREGA", { raiz: RAIZ });

// --- loop de auditoria + parches ---
for (let ronda = 1; ronda <= RONDAS; ronda++) {
	log(`\n═══ ronda ${ronda}: auditoria ═══`);
	const a = await auditar(RAIZ);
	for (const e of a.estructura) log(`   ${e.ok ? "OK   " : "FALTA"} ${e.path} (${e.porque})`);
	for (const av of a.avisos.slice(0, 6)) log(`   aviso: ${av}`);
	log(`errores: ${a.errores.length}`);
	for (const e of a.errores.slice(0, 6)) {
		log(`   ERROR [${e.archivo}] ${e.comando}`);
		log(`      ${String(e.salida).slice(0, 500).replace(/\n/g, "\n      ")}`);
	}
	informe.push({ ronda, errores: a.errores, avisos: a.avisos, estructura: a.estructura });
	fs.writeFileSync(path.join(WORK, "informe.json"), JSON.stringify(informe, null, 1));
	evento("SDD_AUDITORIA", { ronda, errores: a.errores.length, avisos: a.avisos.length });

	if (!a.errores.length) {
		log("\n*** auditoria limpia: estructura SDD completa, sintaxis ok, pruebas en verde y la app arranca ***");
		break;
	}

	log("\n-> se le pide a Meta el PARCHE del error exacto");
	const p = promptParche(a.errores[0], a.errores.slice(1));
	const rr = await engine.ask(p, {
		userId: USUARIO, channel: CANAL,
		watchdogMs: 20_000, watchdogPrompt: "continua",
	});
	let diff = extraerDiff(rr.text ?? "");
	if (!/^--- /m.test(diff)) {
		log("meta no devolvio un diff: se le repregunta pidiendo el unified diff");
		const rr2 = await engine.ask(p + "\n\nResponde SOLO con el unified diff, empezando por una linea --- a/archivo", {
			userId: USUARIO, channel: CANAL, watchdogMs: 20_000, watchdogPrompt: "continua",
		});
		diff = extraerDiff(rr2.text ?? "");
	}
	try {
		const salida = await aplicarPatch(diff, RAIZ);
		log(`parche aplicado: ${salida.trim().slice(0, 200)}`);
	} catch (err) {
		log(`no se pudo aplicar el parche: ${err.message}`);
		break;
	}
}

fs.writeFileSync(path.join(WORK, "informe.json"), JSON.stringify(informe, null, 1));
log(`\nproyecto: ${RAIZ}`);
log(`informe: ${path.join(WORK, "informe.json")}`);
process.exit(0);
