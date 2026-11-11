// engine/sin-navegador.test.mjs
//
// Contrato del broker: se opera con engine/ (protocol-first), SIN navegador,
// y el stack WSP (WhatsApp por CDP) no existe.
//
// Por que: el 2026-11-11 el dueno ordeno "no quiero que meta-api levante mas
// esa mierda de wsp CDP, siempre debe ejecutarse la carpeta engine/". Antes de
// esa orden, server.mjs todavia podia caer al motor "browser" y lanzar un
// Chrome en el puerto 9233 (el mismo que servia al relay), y los watchdogs de
// navegador reiniciaban el broker cada ~5 min. Este test es la red: si alguien
// reintroduce una unidad WSP, un watchdog de navegador o un Chrome en el
// arranque, el test se cae y avisa antes de que el incidente vuelva.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const existe = (p) => existsSync(join(RAIZ, p));
const leer = (p) => readFileSync(join(RAIZ, p), "utf8");

// Unidades de usuario que se retiraron: el puente de WhatsApp y los watchdogs
// que dependian del navegador (revisaban CDP 9233 y reiniciaban el broker).
const UNIDADES_RETIRADAS = [
  "wsp.service",
  "wsp-chrome.service",
  "salud-relay.service",
  "salud-meta.service",
  "donbot-responder.service",
  "vigia-wsp.service",
  "espejo.service",
  "errores-meta.service",
  "vigia.service",
];

// Scripts de servicio del stack retirado. bridge/ NO se borra entero: sus
// helpers y diagnosticos siguen siendo utiles, y bridge/lib/resolver.mjs lo
// importa server.mjs.
const SCRIPTS_RETIRADOS = [
  "bridge/salud-meta.mjs",
  "bridge/salud-relay.mjs",
  "bridge/escuchar-errores-meta.mjs",
  "bridge/vigia.mjs",
  "bridge/vigia-wsp.mjs",
];

test("el stack WSP no existe: ni unidades systemd ni scripts de servicio", () => {
  const unidades = UNIDADES_RETIRADAS.filter((f) => existe(join("systemd", f)));
  assert.deepEqual(
    unidades,
    [],
    `unidades WSP/salud todavia en el repo: ${unidades.join(", ")}`
  );

  const scripts = SCRIPTS_RETIRADOS.filter((f) => existe(f));
  assert.deepEqual(
    scripts,
    [],
    `scripts del stack retirado todavia en el repo: ${scripts.join(", ")}`
  );

  assert.equal(existe("relay"), false, "relay/ (stack WSP) todavia existe");
});

test("server.mjs: el motor por defecto es graphql y aborta si se pide otro", () => {
  const src = leer("server.mjs");
  assert.match(
    src,
    /const ENGINE = String\(process\.env\.META_ENGINE \|\| "graphql"\)/
  );
  assert.match(src, /if \(ENGINE !== "graphql"\)/);
  assert.match(src, /process\.exit\(1\)/);
});

test("server.mjs: no puede lanzar Chrome ni abrir CDP", () => {
  const src = leer("server.mjs");
  assert.doesNotMatch(src, /remote-debugging-port/);
  assert.doesNotMatch(src, /ensureChromeInner/);
  assert.doesNotMatch(src, /killStrays/);
  assert.match(src, /async function ensureChrome\(\)/);
});

test("server.mjs: /warmup responde honestamente que no hay navegador", () => {
  const src = leer("server.mjs");
  assert.match(src, /navegador: false/);
  assert.doesNotMatch(src, /url: \(workers\[0\] && workers\[0\]\.url\)/);
});
