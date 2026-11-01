// gateway.test.mjs — tests golden contra las capturas reales sanitizadas.
// Ejecutar: node --test engine/gateway.test.mjs
//
// Si algo falla tras un cambio, NO se fuerza el resultado: es senal de drift
// de codigo propio o del protocolo (ver TAREAS.md paso 5).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FRAME, buildFrame, parseFrame, decodePb, encodePb, extractJsons,
} from "./pb.mjs";
import { buildRequestPayload, textOf, PROTOCOL } from "./gateway.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const dec = (b64) => Buffer.from(b64, "base64");
const fixtures = fs.readdirSync(FIXTURES_DIR)
	.filter((f) => f.startsWith("capture-ws-") && f.endsWith(".json"))
	.sort();

test("hay fixtures de captura", () => {
	assert.ok(fixtures.length >= 1, "engine/fixtures debe tener capturas");
});

test("constantes de protocolo", () => {
	assert.equal(PROTOCOL.APP_ID, "1522763855472543");
	assert.equal(PROTOCOL.GATEWAY_URL, "wss://gateway.meta.ai/ws/clippy");
	assert.equal(PROTOCOL.AUTH_TYPE, "15:0");
});

for (const name of fixtures) {
	const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
	const fixture = JSON.parse(raw);
	const frames = fixture.frames.map((f) => ({ dir: f.dir, buf: dec(f.data) }));
	const parsed = frames
		.filter(({ buf }) => buf.length > 1)
		.map(({ dir, buf }) => ({ dir, ...parseFrame(buf) }));
	const sentFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_CLIENT);
	const recvFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_SERVER);

	test(`${name}: regla de framing len = total - 6`, () => {
		for (const { dir, buf } of frames) {
			if (buf.length === 1) continue;
			assert.equal(buf.readUInt16LE(3), buf.length - 6, `frame ${dir} tipo 0x${buf[0].toString(16)}`);
		}
	});

	test(`${name}: frames reensamblados byte a byte`, () => {
		for (const { dir, buf } of frames) {
			if (buf.length === 1) continue;
			const p = parseFrame(buf);
			const rebuild = buildFrame(p.type, p.payload, p.prefix ?? p.flag);
			assert.ok(buf.equals(rebuild), `frame ${dir} tipo 0x${p.type.toString(16)} difiere`);
		}
	});

	test(`${name}: decodePb -> encodePb identico`, () => {
		assert.ok(sentFrames.length >= 1, "hay frame de envio");
		const sent = JSON.parse(sentFrames[0].payload.toString("utf8"));
		const captured = Buffer.from(sent.payload, "base64");
		assert.ok(captured.equals(encodePb(decodePb(captured))), "re-encode del pb capturado no es identico");
	});

	test(`${name}: el prompt esta en f2.2 y el texto se extrae del recv`, () => {
		const sent = JSON.parse(sentFrames[0].payload.toString("utf8"));
		const nodes = decodePb(Buffer.from(sent.payload, "base64"));
		const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
		assert.ok(msg, "field 2 anidado (mensaje)");
		const leaf = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str");
		assert.ok(leaf && leaf.str.length > 0, "prompt en f2.2");

		const texts = [];
		let sawPatch = false;
		for (const f of recvFrames) {
			for (const j of extractJsons(f.payload)) {
				if (j.type === "full" && j.response?.sections) {
					const t = textOf(j.response);
					if (t) texts.push(t);
				}
				if (j.type === "patch") {
					sawPatch = true;
					assert.ok(Array.isArray(j.operations), "patch trae operations[]");
				}
			}
		}
		assert.ok(texts.length >= 1, "se extrajo al menos un texto");
		assert.ok(sawPatch, "hay patch de control de fin de stream");
	});

	test(`${name}: fixture sin token real`, () => {
		assert.ok(!/ecto1[0-9A-Za-z._-]{20,}/.test(raw), "fixture sin token real");
	});
}

test("buildRequestPayload: slots por ruta, prompt y ids nuevos", () => {
	const CONV = "11111111-2222-4333-8444-555555555555";
	const TURN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const REQ = "eeeeeeee-ffff-4000-8111-222222222222";
	const { payload, replaced } = buildRequestPayload({
		prompt: "ping de prueba",
		conversationId: CONV,
		turnId: TURN,
		reqId: REQ,
		userId: "1234567890123456",
	});
	assert.ok(replaced >= 6, `slots replaced >= 6, got ${replaced}`);
	const text = payload.toString("latin1");
	assert.ok(text.includes("ping de prueba"), "prompt nuevo presente");
	assert.ok(text.includes(CONV), "conversation nueva presente");
	assert.ok(text.includes(TURN), "turn nuevo presente");
	assert.ok(text.includes(REQ), "req-id nuevo presente");
	assert.ok(text.includes("1234567890123456"), "user id presente");
});

test("buildRequestPayload con los mismos valores del template reproduce el original", () => {
	// el template es la captura mas reciente: sus ids se leen del fixture
	const newest = fixtures[fixtures.length - 1];
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, newest), "utf8"));
	const sentFrame = fixture.frames
		.map((f) => dec(f.data))
		.find((b) => b[0] === FRAME.DATA && b[7] === FRAME.FLAG_CLIENT);
	const sent = JSON.parse(sentFrame.subarray(8).toString("utf8"));
	const captured = Buffer.from(sent.payload, "base64");
	const nodes = decodePb(captured);
	const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
	const prompt = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str").str;
	const turn = msg.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "str").str;
	const conv = msg.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "str").str;

	const { payload } = buildRequestPayload({ prompt, conversationId: conv, turnId: turn, reqId: sent["req-id"] });
	// el re-encode puede diferir en los timestamps (se reescriben a "ahora")
	assert.equal(payload.length, captured.length, "mismo largo que el pb capturado");
});
