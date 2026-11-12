// apikeys.test.mjs — API keys: creacion, hash (nunca el secreto en claro),
// listado sin secreto, revocacion, caducidad y clave de servicio del webchat.
//
// Ejecutar: node --test engine/apikeys.test.mjs
//
// Los tests usan archivos PROPIOS (META_API_KEYS_PATH / META_WEBCHAT_KEY_PATH)
// para no tocar los archivos reales del panel.

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const BASE = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const TMP = fs.mkdtempSync(path.join(BASE, "meta-api-keys-"));
const ARCHIVO = path.join(TMP, ".api-keys.json");
const ARCHIVO_WEBCHAT = path.join(TMP, ".webchat-key");

process.env.META_API_KEYS_PATH = ARCHIVO;
process.env.META_WEBCHAT_KEY_PATH = ARCHIVO_WEBCHAT;

const mod = await import("./apikeys.mjs");

beforeEach(() => {
	try { fs.unlinkSync(ARCHIVO); } catch { /* no existia */ }
	try { fs.unlinkSync(ARCHIVO_WEBCHAT); } catch { /* no existia */ }
});

test("crearClave devuelve un secreto usable con el formato mk_", () => {
	const creada = mod.crearClave({ nombre: "mi portatil", dias: 30 });
	assert.match(creada.clave, /^mk_[A-Za-z0-9_-]{43}$/);
	assert.equal(creada.clave.length, 46);
	assert.equal(creada.nombre, "mi portatil");
	assert.match(creada.expira, /^\d{4}-\d{2}-\d{2}T/);
	assert.ok(creada.id);
});

test("el secreto NO se guarda en claro: solo su hash sha256", () => {
	const creada = mod.crearClave({ nombre: "mi portatil", dias: null });
	const crudo = fs.readFileSync(ARCHIVO, "utf8");
	assert.ok(!crudo.includes(creada.clave), "el secreto no puede estar en el archivo");

	const guardado = JSON.parse(crudo).claves[0];
	const hashEsperado = crypto.createHash("sha256").update(creada.clave, "utf8").digest("hex");
	assert.equal(guardado.hash, hashEsperado);
	assert.notEqual(guardado.hash, creada.clave);
});

test("el archivo de claves se escribe con modo 600", () => {
	mod.crearClave({ nombre: "k", dias: null });
	const st = fs.statSync(ARCHIVO);
	assert.equal(st.mode & 0o777, 0o600);
});

test("listarClaves NO devuelve el secreto ni el hash", () => {
	const creada = mod.crearClave({ nombre: "k", dias: null });
	const lista = mod.listarClaves();
	assert.equal(lista.length, 1);
	const item = lista[0];
	assert.equal(item.id, creada.id);
	assert.equal(item.nombre, "k");
	assert.equal(item.revocado, false);
	assert.equal(item.ultimoUso, null);
	assert.equal(item.expira, null);
	assert.ok(!("clave" in item), "el listado no trae el secreto");
	assert.ok(!("hash" in item), "el listado no trae el hash");
	assert.ok(!JSON.stringify(lista).includes(creada.clave), "el secreto no aparece en el listado");
	// El prefijo permite distinguirla: son los primeros 12 caracteres.
	assert.equal(item.prefijo, creada.clave.slice(0, 12));
	assert.equal(item.prefijo.length, 12);
});

test("una clave valida verifica y actualiza ultimoUso", () => {
	const creada = mod.crearClave({ nombre: "k", dias: null });
	assert.equal(mod.verificarClave(creada.clave), true);
	const item = mod.listarClaves()[0];
	assert.match(item.ultimoUso, /^\d{4}-\d{2}-\d{2}T/);
});

test("una clave con caducidad sigue sirviendo mientras no vence", () => {
	const creada = mod.crearClave({ nombre: "k", dias: 1 });
	assert.ok(creada.expira);
	assert.equal(mod.verificarClave(creada.clave), true);
});

test("una clave expirada deja de servir", () => {
	const creada = mod.crearClave({ nombre: "k", dias: 1 });
	// Se adelanta la caducidad en el archivo (el reloj no se puede mover).
	const datos = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
	datos.claves[0].expira = new Date(Date.now() - 1000).toISOString();
	fs.writeFileSync(ARCHIVO, JSON.stringify(datos, null, 2));
	assert.equal(mod.verificarClave(creada.clave), false);
});

test("dias null deja la clave sin caducidad", () => {
	const creada = mod.crearClave({ nombre: "k", dias: null });
	assert.equal(creada.expira, null);
	assert.equal(mod.listarClaves()[0].expira, null);
});

test("revocarClave invalida la clave de inmediato", () => {
	const creada = mod.crearClave({ nombre: "k", dias: null });
	assert.equal(mod.revocarClave(creada.id), true);
	assert.equal(mod.verificarClave(creada.clave), false);
	assert.equal(mod.listarClaves()[0].revocado, true);
});

test("revocar una clave que no existe devuelve false", () => {
	assert.equal(mod.revocarClave("no-existe"), false);
});

test("una clave revocada no revive aunque el hash siga en el archivo", () => {
	const creada = mod.crearClave({ nombre: "k", dias: null });
	mod.revocarClave(creada.id);
	assert.equal(mod.verificarClave(creada.clave), false);
});

test("crearClave valida el nombre y la caducidad", () => {
	assert.throws(() => mod.crearClave({ nombre: "", dias: null }), /falta 'nombre'/);
	assert.throws(() => mod.crearClave({ nombre: "k", dias: 0 }), /'dias' invalido/);
	assert.throws(() => mod.crearClave({ nombre: "k", dias: -5 }), /'dias' invalido/);
	assert.throws(() => mod.crearClave({ nombre: "k", dias: 1.5 }), /'dias' invalido/);
});

test("una clave que no existe no verifica", () => {
	assert.equal(mod.verificarClave("mk_inventada"), false);
	assert.equal(mod.verificarClave(""), false);
	assert.equal(mod.verificarClave(undefined), false);
});

test("la clave de servicio del webchat se genera sola y se reutiliza", () => {
	const primera = mod.claveServicioWebchat();
	assert.match(primera, /^mk_[A-Za-z0-9_-]{43}$/);
	const segunda = mod.claveServicioWebchat();
	assert.equal(segunda, primera, "la clave no se regenera en cada llamada");
	const st = fs.statSync(ARCHIVO_WEBCHAT);
	assert.equal(st.mode & 0o777, 0o600);
	// Es una credencial LOCAL de servicio: se guarda en claro para que el
	// proxy la pueda leer del disco.
	assert.equal(fs.readFileSync(ARCHIVO_WEBCHAT, "utf8").trim(), primera);
});

test("la clave de servicio del webchat se compara bien", () => {
	const clave = mod.claveServicioWebchat();
	assert.equal(mod.esClaveServicioWebchat(clave), true);
	assert.equal(mod.esClaveServicioWebchat("mk_otra"), false);
	assert.equal(mod.esClaveServicioWebchat(""), false);
});

test("la clave de servicio del webchat no aparece en la lista de claves", () => {
	const servicio = mod.claveServicioWebchat();
	mod.crearClave({ nombre: "k", dias: null });
	const lista = mod.listarClaves();
	assert.equal(lista.length, 1);
	assert.ok(!JSON.stringify(lista).includes(servicio));
});
