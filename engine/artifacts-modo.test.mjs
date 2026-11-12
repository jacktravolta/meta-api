// artifacts-modo.test.mjs — T4: el modo de entrega de archivos lo gobierna el
// ajuste del panel y no solo el entorno.
//
// Ejecutar: node --test engine/artifacts-modo.test.mjs

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { modoEntrega } from "./artifacts.mjs";

beforeEach(() => {
	delete process.env.META_FILE_STORAGE;
});

test("sin opcion, manda el valor por defecto (entorno)", () => {
	assert.equal(modoEntrega(), "url");
	process.env.META_FILE_STORAGE = "local";
	assert.equal(modoEntrega(), "local");
	process.env.META_FILE_STORAGE = "url";
	assert.equal(modoEntrega(), "url");
});

test("la opcion gana sobre el entorno", () => {
	process.env.META_FILE_STORAGE = "url";
	assert.equal(modoEntrega("local"), "local");
	process.env.META_FILE_STORAGE = "local";
	assert.equal(modoEntrega("url"), "url");
});

test("una opcion desconocida cae al valor por defecto", () => {
	process.env.META_FILE_STORAGE = "local";
	assert.equal(modoEntrega("x"), "local");
	assert.equal(modoEntrega(null), "local");
	assert.equal(modoEntrega(undefined), "local");
});
