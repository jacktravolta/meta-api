// gateway.test.mjs — tests golden contra la captura real sanitizada.
// Ejecutar: node --test engine/gateway.test.mjs
// Si algo de esto falla tras un cambio, NO se fuerza el resultado: es senal
// de drift de codigo propio o del protocolo (ver TAREAS.md paso 5).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FRAME, buildFrame, parseFrame, decodePb, encodePb, extractJsons,
} from "./pb.mjs";
import {
	buildRequestPayload, insertSlots, textOf, PROTOCOL,
} from "./gateway.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/capture-ws-20261031.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const dec = (b64) => Buffer.from(b64, "base64");

const frames = fixture.frames.map((f) => ({ dir: f.dir, buf: dec(f.data) }));
const parsed = frames
	.filter(({ buf }) => buf.length > 1)
	.map(({ dir, buf }) => ({ dir, ...parseFrame(buf) }));
const dataFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_CLIENT);
const recvFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_SERVER);

test("constantes de protocolo capturadas", () => {
	assert.equal(PROTOCOL.APP_ID, "1522763855472543");
	assert.equal(PROTOCOL.GATEWAY_URL, "wss://gateway.meta.ai/ws/clippy");
	assert.equal(PROTOCOL.AUTH_TYPE, "15:0");
});

test("parser de frames: regla len = total - 6 en TODA la captura", () => {
	assert.ok(parsed.length >= 6, "fixture tiene frames de datos");
	for (const { dir, buf } of frames) {
		if (buf.length === 1) continue; // keepalive de 1 byte
		assert.equal(buf.readUInt16LE(3), buf.length - 6, `frame ${dir} tipo 0x${buf[0].toString(16)}`);
	}
});

test("golden: frames reensamblados byte a byte", () => {
	for (const { dir, buf } of frames) {
		if (buf.length === 1) continue; // keepalive de 1 byte
		const p = parseFrame(buf);
		const rebuild = buildFrame(p.type, p.payload, p.prefix ?? p.flag);
		assert.ok(buf.equals(rebuild), `frame ${dir} tipo 0x${p.type.toString(16)} difiere`);
	}
});

const sentFrame = dataFrames[0];
const sentJson = JSON.parse(sentFrame.payload.toString("utf8"));
const capturedPayload = Buffer.from(sentJson.payload, "base64");

test("golden: decodePb -> encodePb identico al pb capturado", () => {
	const nodes = decodePb(capturedPayload);
	const reencoded = encodePb(nodes);
	assert.ok(capturedPayload.equals(reencoded),
		"re-encode del pb capturado no es identico");
});

test("golden: el prompt capturado vive en f2.2", () => {
	const nodes = decodePb(capturedPayload);
	const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
	assert.ok(msg, "field 2 anidado");
	const leaf = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str");
	assert.equal(leaf.str, "responde solo: hola");
});

test("buildRequestPayload: slots reemplazados y prompt nuevo", () => {
	const CONV = "11111111-2222-4333-8444-555555555555";
	const TURN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const { payload, replaced } = buildRequestPayload({
		prompt: "ping",
		conversationId: CONV,
		turnId: TURN,
	});
	assert.ok(replaced >= 2, `al menos prompt+conv/turn reemplazados, got ${replaced}`);
	assert.ok(!payload.toString("latin1").includes("responde solo: hola"), "prompt viejo afuera");
	const hex = payload.toString("latin1");
	assert.ok(hex.includes(CONV), "nueva conversacion presente");
	assert.ok(hex.includes(TURN), "nuevo turn presente");
});

test("buildRequestPayload con valores capturados reproduce el original", () => {
	const { payload } = buildRequestPayload({
		prompt: "responde solo: hola",
		conversationId: "29cb0c02-c081-4f5f-a63d-5637c3ee9225",
		turnId: "5d838aa8-7de2-4909-848a-22f39edb479c",
	});
	assert.ok(capturedPayload.equals(payload), "con slots identicos debe reproducir el pb capturado");
});

test("recv: extractJsons encuentra las secciones y el texto final", () => {
	let found = false;
	const texts = [];
	for (const f of recvFrames) {
		for (const j of extractJsons(f.payload)) {
			if (j.type === "full" && j.response?.sections) {
				found = true;
				const t = textOf(j.response);
				if (t) texts.push(t);
			}
			if (j.type === "patch") {
				assert.ok(Array.isArray(j.operations), "patch trae operations[]");
				if (j.seq === 1) assert.equal(j.operations.length, 0, "seq 1 = patch vacio (fin de stream)");
			}
		}
	}
	assert.ok(found, "al menos un full con sections");
	assert.deepEqual(texts, ["hola"], "el texto final capturado es 'hola'");
});

test("respuesta no perfora el fixture con el token real", () => {
	fs.readFile(FIXTURE, "utf8", (err, raw) => {
		assert.ifError(err);
		assert.ok(!/ecto1[0-9A-Za-z._-]{20,}/.test(raw), "fixture sin token real");
	});
});

void insertSlots;
