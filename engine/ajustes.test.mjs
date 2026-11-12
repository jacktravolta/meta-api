// ajustes.test.mjs — ajustes en caliente: valores por defecto, persistencia y
// validacion.
//
// Ejecutar: node --test engine/ajustes.test.mjs
//
// Los tests usan un archivo PROPIO (META_AJUSTES_PATH) para no tocar el
// archivo real del panel (engine/.ajustes.json).

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const TMP = fs.mkdtempSync(path.join(BASE, "meta-api-ajustes-"));
const ARCHIVO = path.join(TMP, ".ajustes.json");

// El path se resuelve en cada llamada, asi que se puede setear antes de usar.
process.env.META_AJUSTES_PATH = ARCHIVO;
delete process.env.META_FILE_STORAGE;
delete process.env.META_AUTH_MODE;

const mod = await import("./ajustes.mjs");

beforeEach(() => {
	try { fs.unlinkSync(ARCHIVO); } catch { /* no existia */ }
	delete process.env.META_FILE_STORAGE;
	delete process.env.META_AUTH_MODE;
});

test("sin archivo, los valores por defecto son url y abierta", () => {
	const a = mod.ajustesActuales();
	assert.equal(a.fileStorage, "url");
	assert.equal(a.auth, "abierta");
	assert.match(a.actualizado, /^\d{4}-\d{2}-\d{2}T/);
});

test("sin archivo, el entorno define el valor inicial", () => {
	process.env.META_FILE_STORAGE = "local";
	process.env.META_AUTH_MODE = "api-key";
	const a = mod.ajustesActuales();
	assert.equal(a.fileStorage, "local");
	assert.equal(a.auth, "api-key");
});

test("un valor de entorno desconocido se ignora (manda el por defecto)", () => {
	process.env.META_FILE_STORAGE = "banana";
	process.env.META_AUTH_MODE = "abierta";
	const a = mod.ajustesActuales();
	assert.equal(a.fileStorage, "url");
	assert.equal(a.auth, "abierta");
});

test("guardarAjustes persiste y devuelve el objeto completo", () => {
	const guardado = mod.guardarAjustes({ fileStorage: "local" });
	assert.equal(guardado.fileStorage, "local");
	assert.equal(guardado.auth, "abierta");
	assert.match(guardado.actualizado, /^\d{4}-\d{2}-\d{2}T/);

	const enDisco = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
	assert.equal(enDisco.fileStorage, "local");
	assert.equal(enDisco.auth, "abierta");
	assert.equal(enDisco.actualizado, guardado.actualizado);
});

test("el archivo se escribe con modo 600", () => {
	mod.guardarAjustes({ fileStorage: "local" });
	const st = fs.statSync(ARCHIVO);
	assert.equal(st.mode & 0o777, 0o600);
});

test("un cambio parcial conserva el otro campo", () => {
	mod.guardarAjustes({ fileStorage: "local" });
	const segundo = mod.guardarAjustes({ auth: "api-key" });
	assert.equal(segundo.fileStorage, "local");
	assert.equal(segundo.auth, "api-key");
});

test("el valor guardado sobrevive a una recarga del modulo", async () => {
	mod.guardarAjustes({ fileStorage: "local", auth: "api-key" });
	const recargado = await import("./ajustes.mjs?v=recarga-1");
	const a = recargado.ajustesActuales();
	assert.equal(a.fileStorage, "local");
	assert.equal(a.auth, "api-key");
});

test("el archivo manda sobre el entorno", async () => {
	mod.guardarAjustes({ fileStorage: "local" });
	process.env.META_FILE_STORAGE = "url";
	const recargado = await import("./ajustes.mjs?v=recarga-2");
	assert.equal(recargado.ajustesActuales().fileStorage, "local");
});

test("un fileStorage invalido se rechaza con un mensaje claro", () => {
	assert.throws(
		() => mod.guardarAjustes({ fileStorage: "x" }),
		(err) => {
			assert.match(err.message, /fileStorage invalido/);
			assert.match(err.message, /url, local/);
			return true;
		},
	);
});

test("un auth invalido se rechaza con un mensaje claro", () => {
	assert.throws(
		() => mod.guardarAjustes({ auth: "abierta " }),
		(err) => {
			assert.match(err.message, /auth invalido/);
			assert.match(err.message, /abierta, api-key/);
			return true;
		},
	);
});

test("un campo desconocido se rechaza", () => {
	assert.throws(() => mod.guardarAjustes({ modo: "local" }), /campo desconocido/);
});

test("un cuerpo que no es objeto se rechaza", () => {
	assert.throws(() => mod.guardarAjustes("local"), /cuerpo/);
});

test("un valor invalido no cambia lo que estaba guardado", () => {
	mod.guardarAjustes({ fileStorage: "local", auth: "abierta" });
	assert.throws(() => mod.guardarAjustes({ fileStorage: "x" }));
	const a = mod.ajustesActuales();
	assert.equal(a.fileStorage, "local");
	assert.equal(a.auth, "abierta");
});
