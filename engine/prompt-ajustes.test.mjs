// prompt-ajustes.test.mjs — prompt del agente: estado por defecto, guardado,
// reset al prompt base, tope e invalidacion por mtime (edicion manual).
//
// Ejecutar: node --test engine/prompt-ajustes.test.mjs
//
// Los tests usan un archivo PROPIO (META_PROMPT_PATH) para no tocar el
// archivo real del panel (engine/.prompt-ajustes.json).

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const TMP = fs.mkdtempSync(path.join(BASE, "meta-api-prompt-"));
const ARCHIVO = path.join(TMP, ".prompt-ajustes.json");

// El path se resuelve en cada llamada, asi que se puede setear antes de usar.
process.env.META_PROMPT_PATH = ARCHIVO;

const mod = await import("./prompt-ajustes.mjs");

beforeEach(() => {
	try { fs.unlinkSync(ARCHIVO); } catch { /* no existia */ }
});

test("sin archivo: prompt base (vacio) y actualizadoEn null", () => {
	const s = mod.getPrompt();
	assert.equal(s.prompt, "");
	assert.equal(s.actualizadoEn, null);
});

test("guardar persiste y devuelve el estado ya aplicado", () => {
	const guardado = mod.savePrompt({ prompt: "Responde en español." });
	assert.equal(guardado.prompt, "Responde en español.");
	assert.match(guardado.actualizadoEn, /^\d{4}-\d{2}-\d{2}T/);

	// El turno siguiente (una lectura nueva) ya ve el prompt guardado.
	const leido = mod.getPrompt();
	assert.equal(leido.prompt, "Responde en español.");
	const enDisco = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
	assert.equal(enDisco.prompt, "Responde en español.");
	assert.equal(enDisco.actualizadoEn, guardado.actualizadoEn);
});

test("el archivo se escribe con modo 600", () => {
	mod.savePrompt({ prompt: "x" });
	const st = fs.statSync(ARCHIVO);
	assert.equal(st.mode & 0o777, 0o600);
});

test('guardar "" es el reset: vuelve al prompt base sin borrar el archivo', () => {
	mod.savePrompt({ prompt: "Reglas del propietario." });
	const reset = mod.savePrompt({ prompt: "" });
	assert.equal(reset.prompt, "");
	assert.match(reset.actualizadoEn, /^\d{4}-\d{2}-\d{2}T/);

	const leido = mod.getPrompt();
	assert.equal(leido.prompt, "");
	// Queda constancia del reset (la UI muestra "Último guardado").
	assert.ok(leido.actualizadoEn);
	assert.ok(fs.existsSync(ARCHIVO));
});

test("un prompt que excede el tope se rechaza con un mensaje claro", () => {
	const largo = "a".repeat(mod.PROMPT_MAX_CHARS + 1);
	assert.throws(
		() => mod.savePrompt({ prompt: largo }),
		(err) => {
			assert.match(err.message, /excede el maximo/);
			assert.match(err.message, new RegExp(String(mod.PROMPT_MAX_CHARS)));
			return true;
		},
	);
	// El rechazo NO cambia lo que estaba guardado.
	assert.equal(mod.getPrompt().prompt, "");
});

test("exactamente el tope se acepta", () => {
	const justo = "a".repeat(mod.PROMPT_MAX_CHARS);
	mod.savePrompt({ prompt: justo });
	assert.equal(mod.getPrompt().prompt, justo);
});

test("un prompt que no es string se rechaza", () => {
	assert.throws(() => mod.savePrompt({ prompt: 42 }), /tiene que ser un texto/);
	assert.throws(() => mod.savePrompt({ prompt: null }), /tiene que ser un texto/);
	assert.throws(() => mod.savePrompt({ prompt: { mal: true } }), /tiene que ser un texto/);
});

test("un cuerpo que no es objeto se rechaza", () => {
	assert.throws(() => mod.savePrompt("texto"), /cuerpo/);
	assert.throws(() => mod.savePrompt(["prompt"]), /cuerpo/);
});

test("un campo desconocido se rechaza", () => {
	assert.throws(() => mod.savePrompt({ prompt: "x", modo: "y" }), /campo desconocido/);
});

test("un valor invalido no cambia lo que estaba guardado", () => {
	mod.savePrompt({ prompt: "Reglas." });
	assert.throws(() => mod.savePrompt({ prompt: { mal: true } }));
	assert.equal(mod.getPrompt().prompt, "Reglas.");
});

test("una edicion manual del archivo se toma sin reiniciar (invalidacion por mtime)", async () => {
	mod.savePrompt({ prompt: "version 1" });
	// Se escribe DETRAS del modulo (como una edicion a mano) y se fuerza un
	// mtime distinto: el cache tiene que darse cuenta y releer.
	const futuro = new Date(Date.now() + 5000);
	fs.writeFileSync(
		ARCHIVO,
		JSON.stringify({ prompt: "editado a mano", actualizadoEn: futuro.toISOString() }, null, 2) + "\n",
	);
	fs.utimesSync(ARCHIVO, futuro, futuro);
	const s = mod.getPrompt();
	assert.equal(s.prompt, "editado a mano");
	assert.equal(s.actualizadoEn, futuro.toISOString());
});

test("un archivo corrupto NO rompe la lectura: vuelve al prompt base", () => {
	fs.writeFileSync(ARCHIVO, "{ esto no es json");
	const s = mod.getPrompt();
	assert.equal(s.prompt, "");
	assert.equal(s.actualizadoEn, null);
});

test("un archivo valido sin actualizadoEn usa el mtime como referencia", () => {
	fs.writeFileSync(ARCHIVO, JSON.stringify({ prompt: "a mano" }));
	const s = mod.getPrompt();
	assert.equal(s.prompt, "a mano");
	assert.match(s.actualizadoEn, /^\d{4}-\d{2}-\d{2}T/);
});

test("el estado guardado sobrevive a una recarga del modulo", async () => {
	mod.savePrompt({ prompt: "persistente" });
	const recargado = await import("./prompt-ajustes.mjs?v=recarga-1");
	assert.equal(recargado.getPrompt().prompt, "persistente");
});
