// pacman-loop.mjs — Meta desarrolla el juego; este script solo orchestra.
//
//   node engine/pacman-loop.mjs [--rondas 10] [--dir games/pacman] [--puerto 8123]
//                                [--testear-actual] [--feedback "texto"]
//
// REGLAS DEL ENCARGO:
//   - Este script NO corrige el codigo. Si la prueba falla, se le manda a Meta
//     el codigo actual + los errores + el feedback humano, y se aplica TAL CUAL
//     lo que Meta devuelva.
//   - Meta entrega el codigo por PATCHES: el codigo COMPLETO esta en la
//     respuesta ACUMULADA (no en los frames sueltos).
//   - Si Meta se queda callado, el motor le manda "continua" (watchdog).
//   - La prueba corre en el Chrome VISIBLE del usuario (CDP 9298): la pestana
//     del juego queda abierta para supervision humana.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetaEngine } from "./broker-engine.mjs";
import { testGame, serveDir } from "./game-tester.mjs";
import { evento } from "./eventos.mjs";
import { REGLAS_CODIGO } from "./prompts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const has = (n) => args.includes(n);

const RONDAS = Number(arg("--rondas", 10));
const DIR = path.resolve(ROOT, arg("--dir", "games/pacman"));
const PUERTO = Number(arg("--puerto", 8123));
const CDP_PORT = Number(arg("--cdp", 9298));
const USUARIO = arg("--usuario", "pacman");
const CANAL = arg("--canal", "dev");
const FEEDBACK = arg("--feedback", null);
const INDEX = path.join(DIR, "index.html");
const TESTEAR_ACTUAL = has("--testear-actual") || (has("--seguir") && fs.existsSync(INDEX));

fs.mkdirSync(DIR, { recursive: true });

// ---------- extraccion del codigo ----------
function bloquesDe(respuesta) {
	const out = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		if (o.__typename === "GenAICodeUXPrimitive" && Array.isArray(o.code_blocks)) {
			out.push({ lang: (o.language ?? "").toLowerCase(), code: o.code_blocks.map((b) => b.content ?? "").join("") });
		}
		for (const v of Object.values(o)) walk(v);
	};
	walk(respuesta);
	const mejor = new Map();
	for (const b of out) {
		if (!b.code.trim()) continue;
		const key = b.lang || "txt";
		const prev = mejor.get(key);
		if (!prev || b.code.length > prev.code.length) mejor.set(key, b);
	}
	return [...mejor.values()];
}

// Meta a veces entrega el HTML como artefacto incrustado en su front (icono
// "<>") en vez de bloque de codigo. Si no hay code primitive, se busca
// cualquier documento HTML completo dentro de la respuesta.
function htmlEmbebido(respuesta) {
	let mejor = null;
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const v of Object.values(o)) {
			if (typeof v === "string" && v.length > 400 && /<!doctype html|<html/i.test(v)) {
				if (!mejor || v.length > mejor.length) mejor = v;
			} else walk(v);
		}
	};
	walk(respuesta);
	return mejor;
}

function extraerCodigo(jsons, respuestaAcumulada) {
	const deAcumulado = bloquesDe(respuestaAcumulada);
	if (deAcumulado.length) return deAcumulado;
	const embebido = htmlEmbebido(respuestaAcumulada);
	if (embebido) return [{ lang: "html", code: embebido, origen: "artefacto" }];
	const out = [];
	for (const j of jsons) out.push(...bloquesDe(j));
	const mejor = new Map();
	for (const b of out) {
		if (!b.code.trim()) continue;
		const key = b.lang || "txt";
		const prev = mejor.get(key);
		if (!prev || b.code.length > prev.code.length) mejor.set(key, b);
	}
	return [...mejor.values()];
}

function escribir(bloques) {
	const html = bloques.filter((b) => b.lang.includes("html") || /<!doctype|<html/i.test(b.code));
	const css = bloques.filter((b) => b.lang.includes("css") || (!html.includes(b) && /^\s*[.#@a-z][^{]*\{[^}]*\}/i.test(b.code) && !/\bfunction\b|=>|const |let |var /.test(b.code)));
	const js = bloques.filter((b) => !html.includes(b) && !css.includes(b));
	const escritos = [];

	if (html.length) {
		fs.writeFileSync(INDEX, html[0].code);
		escritos.push("index.html");
	} else {
		const cssTxt = css.map((b) => b.code).join("\n");
		const jsTxt = js.map((b) => b.code).join("\n");
		fs.writeFileSync(INDEX,
			`<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>Pac-Man</title>\n<style>\n${cssTxt}\n</style>\n</head>\n<body>\n<script>\n${jsTxt}\n</script>\n</body>\n</html>\n`);
		escritos.push("index.html (envoltura)");
	}
	if (css.length && html.length) { fs.writeFileSync(path.join(DIR, "styles.css"), css.map((b) => b.code).join("\n")); escritos.push("styles.css"); }
	if (js.length && html.length) { fs.writeFileSync(path.join(DIR, "game.js"), js.map((b) => b.code).join("\n")); escritos.push("game.js"); }
	return { escritos, counts: { html: html.length, css: css.length, js: js.length } };
}

// ---------- prompts ----------
const PROMPT_INICIAL = [
	"Genera YA un Pac-Man completo en JavaScript vanilla, en un solo archivo index.html (HTML+CSS+JS inline, sin librerias ni assets externos).",
	"Debe tener: laberinto con puntos en canvas, flechas y WASD, 4 fantasmas (3 persiguen, 1 huye), bolos de poder, vidas, marcador, niveles, pantalla de inicio y de fin, y SONIDOS sintetizados con Web Audio (punto, bolo, fantasma, muerte, fondo).",
	"Sin errores de consola. Codigo compacto y directo.",
	"Responde SOLO con el bloque de codigo html completo.",
	REGLAS_CODIGO,
].join("\n");

function promptCorreccion(codigo, errores, checksFallidos) {
	return [
		"El juego que me diste NO funciona. Te paso el codigo actual y los errores que detecto al ejecutarlo en un navegador real. Arreglalo y responde SOLO con el archivo index.html COMPLETO y corregido en un unico bloque de codigo tipo html. No me expliques los cambios: solo el codigo final.",
		FEEDBACK ? `\nFEEDBACK DE UN USUARIO HUMANO (OBLIGATORIO, aplicalo):\n${FEEDBACK}\n` : "",
		"\nERRORES DETECTADOS:",
		errores.length ? errores.map((e) => "- " + e).join("\n") : "(sin excepciones, pero las comprobaciones fallaron)",
		"\nCOMPROBACIONES QUE FALLARON:",
		checksFallidos.map((c) => "- " + c).join("\n"),
		"\nCODIGO ACTUAL:",
		codigo,
		REGLAS_CODIGO,
	].filter(Boolean).join("\n");
}

// ---------- loop ----------
const engine = new MetaEngine({ mode: "session", debug: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const informe = [];

log(`directorio del juego: ${DIR}`);
log(`Chrome visible en CDP ${CDP_PORT} (pestana del juego para supervision humana)`);
if (FEEDBACK) log(`feedback humano: ${FEEDBACK.slice(0, 120)}`);

const { srv, url } = await serveDir(DIR, PUERTO);
log(`servidor local: ${url}`);

let codigoActual = "";

for (let ronda = 1; ronda <= RONDAS; ronda++) {
	const jsons = [];
	const primera = ronda === 1;
	const testearSinPedir = primera && TESTEAR_ACTUAL && fs.existsSync(INDEX);
	const prompt = testearSinPedir ? null
		: primera ? PROMPT_INICIAL
		: promptCorreccion(codigoActual, informe.at(-1)?.errores ?? [], informe.at(-1)?.checksFallidos ?? []);

	log(`\n═══ ronda ${ronda}: ${testearSinPedir ? "probando el codigo que ya esta en disco" : primera ? "pidiendole a Meta el juego" : "pidiendole a Meta la correccion"} ═══`);

	if (!testearSinPedir) {
		let r;
		try {
			r = await engine.ask(prompt, {
				userId: USUARIO, channel: CANAL,
				onJson: (j) => jsons.push(j),
				watchdogMs: 20_000, watchdogPrompt: "continua",
			});
			if (r.nudge) log(`watchdog: meta se callo ${Math.round(r.nudge.ms / 1000)}s -> se le mando "continua"`);
		} catch (err) {
			log(`ERROR al preguntar a Meta: ${err.message}`);
			informe.push({ ronda, errores: [`meta: ${err.message}`], checksFallidos: ["no se pudo pedir a meta"] });
			continue;
		}
		const bloques = extraerCodigo(jsons, r.response);
		log(`meta respondio ${(r.text ?? "").length} chars | bloques de codigo: ${bloques.length} (${bloques.map((b) => b.lang || "?").join(", ")})`);
		if (!bloques.length) {
			log("meta NO devolvio codigo: se le vuelve a pedir");
			informe.push({ ronda, errores: ["meta no devolvio ningun bloque de codigo"], checksFallidos: ["sin codigo"] });
			continue;
		}
		const { escritos, counts } = escribir(bloques);
		log(`archivos escritos: ${escritos.join(", ")} | bloques html/css/js: ${counts.html}/${counts.css}/${counts.js}`);
	}

	codigoActual = fs.readFileSync(INDEX, "utf8");
	log(`index.html: ${codigoActual.length} chars`);

	// ---------- prueba en Chrome visible ----------
	const prueba = await testGame({ dir: DIR, port: PUERTO, cdpPort: CDP_PORT, url, mantenerPestana: true });
	const checksFallidos = Object.entries(prueba.checks).filter(([, ok]) => !ok).map(([k]) => k);
	log(`prueba: ${Object.values(prueba.checks).filter(Boolean).length}/${Object.keys(prueba.checks).length} checks ok | errores: ${prueba.errores.length}`);
	for (const [k, ok] of Object.entries(prueba.checks)) log(`   ${ok ? "OK  " : "FALLA"} ${k}`);
	for (const e of prueba.errores.slice(0, 6)) log(`   err: ${e.slice(0, 160)}`);

	const ok = checksFallidos.length === 0 && prueba.errores.length === 0;
	informe.push({ ronda, checks: prueba.checks, checksFallidos, errores: prueba.errores, warnings: prueba.warnings });
	evento("PACMAN_RONDA", { ronda, checks_ok: Object.values(prueba.checks).filter(Boolean).length, errores: prueba.errores.length, chars: codigoActual.length });
	fs.writeFileSync(path.join(DIR, "informe.json"), JSON.stringify(informe, null, 1));

	if (ok) {
		log("\n*** el juego funciona: sin errores y todos los checks en verde ***");
		break;
	}
	log(`\n-> se le manda a Meta el codigo + los ${prueba.errores.length} errores y ${checksFallidos.length} checks fallidos`);
}

fs.writeFileSync(path.join(DIR, "informe.json"), JSON.stringify(informe, null, 1));
log(`\ninforme: ${path.join(DIR, "informe.json")}`);
log("la pestana del juego queda abierta en el Chrome visible para supervision.");
process.exit(0);
