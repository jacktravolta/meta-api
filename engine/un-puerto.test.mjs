// El front (webchat) y la API viven en el MISMO puerto: 127.0.0.1:8055.
//
// Este test falla si esa unificacion se rompe por cualquier motivo:
//   - el front deja de servirse en "/"
//   - el front pierde alguna de las rutas /api/* que consume
//   - la traduccion /api/* -> /v1/* deja de traducir el cuerpo
//   - el front deja de estar exento de la puerta de auth en loopback
//   - la API OpenAI (/v1/*) deja de estar en el contrato
//
// Se puede correr solo: node --test engine/un-puerto.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(RAIZ, "server.mjs"), "utf8");
const FRONT = join(RAIZ, "webchat", "index.html");

// Las rutas que el front consume de verdad (ver webchat/index.html).
const RUTAS_FRONT = [
  "/api/estado",
  "/api/chat",
  "/api/clear",
  "/api/ajustes",
  "/api/keys",
  "/api/sesion",
  "/api/sesion/abrir",
  "/api/sesion/capturar",
  "/api/prompt",
];

test("el front se sirve en el mismo puerto que la API", () => {
  assert.ok(existsSync(FRONT), "webchat/index.html no existe: no hay front que servir");
  assert.match(SRC, /const FRONT_WEBCHAT/, "server.mjs no declara la ruta del front");
  assert.match(SRC, /url\.pathname === "\/"/, "server.mjs no sirve el front en /");
  assert.match(SRC, /text\/html/, "el front no se sirve como HTML");
});

test("el front conserva todas las rutas /api/* que consume", () => {
  for (const ruta of RUTAS_FRONT) {
    assert.ok(SRC.includes(`"${ruta}"`), `el front perdio la ruta ${ruta}`);
  }
});

test("las rutas /api/* se traducen a las /v1/* que ya existen", () => {
  const pares = {
    "/api/ajustes": "/v1/ajustes",
    "/api/keys": "/v1/keys",
    "/api/sesion": "/v1/sesion",
    "/api/sesion/abrir": "/v1/sesion/abrir",
    "/api/sesion/capturar": "/v1/sesion/capturar",
    "/api/prompt": "/v1/prompt",
  };
  for (const [front, api] of Object.entries(pares)) {
    assert.ok(SRC.includes(`"${front}", "${api}"`), `falta la traduccion ${front} -> ${api}`);
  }
  assert.ok(SRC.includes('"/v1/chat/completions"'), "/api/chat no se traduce a /v1/chat/completions");
  assert.ok(SRC.includes('"/v1/chat/clear"'), "/api/clear no se traduce a /v1/chat/clear");
});

test("la traduccion mueve el cuerpo del front al de la API", () => {
  // El front manda {mensajes, user, model, modo}; la API espera
  // {messages, user, model, engine_mode}.
  assert.match(SRC, /messages: Array\.isArray\(b\.mensajes\)/, "los mensajes no se traducen");
  assert.match(SRC, /engine_mode: modoEngine\(b\.modo\)/, "el modo de identidad no se traduce");
  assert.match(SRC, /stream: true/, "el SSE no se pide explicitamente");
});

test("/api/estado es el agregado de salud y sesion", () => {
  assert.match(SRC, /pathname === "\/api\/estado"/, "no existe la ruta /api/estado");
  assert.match(SRC, /payloadHealth\(\)/, "/api/estado no usa el payload de salud");
  assert.match(SRC, /payloadSesion\(\)/, "/api/estado no usa el payload de sesion");
  // Las claves que el front lee del agregado.
  for (const clave of ["identidad", "logueado", "tiene_sesion", "modos_disponibles", "caidaAInvitado"]) {
    assert.ok(SRC.includes(clave), `el agregado no expone ${clave}`);
  }
});

test("el front queda exento de la puerta de auth solo en loopback", () => {
  assert.match(SRC, /function rutaDelFront/, "no existe rutaDelFront");
  assert.match(SRC, /rutaDelFront\(pathname\) && esLoopback\(req\)/, "el front no esta exento en loopback");
  // La API cruda sigue protegida: /v1/chat/completions NO es ruta de front.
  assert.match(SRC, /url\.pathname === "\/v1\/chat\/completions"/, "la API OpenAI dejo de estar en el contrato");
});

test("la API OpenAI y el front conviven en el mismo puerto (prueba real)", async () => {
  const puerto = 18000 + Math.floor(Math.random() * 800);
  const hijo = spawn(process.execPath, [join(RAIZ, "server.mjs")], {
    cwd: RAIZ,
    env: { ...process.env, META_API_PORT: String(puerto), META_ENGINE: "graphql" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${puerto}`;
  try {
    // Espera a que levante.
    let listo = false;
    for (let i = 0; i < 60 && !listo; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await fetch(`${base}/health`);
        listo = r.ok;
      } catch { /* todavia no */ }
    }
    assert.ok(listo, "el broker no levanto en el puerto de prueba");

    // 1) el front se sirve en la raiz.
    const front = await fetch(`${base}/`);
    assert.equal(front.status, 200, "GET / no devolvio el front");
    assert.match(front.headers.get("content-type") || "", /text\/html/, "GET / no es HTML");
    assert.match(await front.text(), /<html/i, "GET / no devolvio el HTML del webchat");

    // 2) la API sigue viva en el mismo puerto.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, "/health dejo de responder");
    assert.equal((await health.json()).status, "ok", "/health no esta ok");

    // 3) el front recibe el agregado de estado con las claves que espera.
    const estado = await fetch(`${base}/api/estado`);
    assert.equal(estado.status, 200, "/api/estado no respondio 200");
    const d = await estado.json();
    for (const clave of ["ok", "api", "modo", "identidad", "logueado", "tiene_sesion", "raw"]) {
      assert.ok(clave in d, `/api/estado no devuelve ${clave}`);
    }

    // 4) /api/* se traduce de verdad: el cuerpo vacio llega al manejador de la
    //    API como {messages: []} y responde SU 400, no uno del front.
    const chat = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensajes: [], user: "test", modo: "session" }),
    });
    assert.equal(chat.status, 400, "/api/chat no llego al manejador de la API");
    assert.match(
      JSON.stringify(await chat.json()),
      /messages\[\]\.role user required/,
      "/api/chat no se traduzco al contrato de la API",
    );
  } finally {
    hijo.kill("SIGTERM");
  }
});
