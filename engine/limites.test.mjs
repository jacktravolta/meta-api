// limites.test.mjs — limites de tamano del frame DGW y particion del prompt.
//
// Ejecutar: node --test engine/limites.test.mjs
//
// Contexto (medido en vivo el 2026-11-01): el request de opencode (prompt de
// sistema + schemas de 20 tools + historial) generaba un envelope de 358908
// bytes y el frame DGW tiene el largo en u16 (65535) -> RangeError de Node y
// "Compaction produced no summary" en el cliente.

import test from "node:test";
import assert from "node:assert/strict";
import { buildFrame, FRAME, MAX_FRAME_BODY, MAX_PROMPT_BYTES } from "./pb.mjs";
import { buildRequestPayload, tieneCodigo } from "./gateway.mjs";
import { dividirPrompt, piezaDeContexto } from "./partir.mjs";
import { toolsContract } from "./toolcall.mjs";

test("buildFrame corta con un error claro cuando el cuerpo pasa de 65535", () => {
	const grande = Buffer.alloc(MAX_FRAME_BODY + 1, 0x61);
	assert.throws(
		() => buildFrame(FRAME.DATA, grande, FRAME.FLAG_CLIENT),
		(err) => {
			assert.match(err.message, /frame DGW demasiado grande/);
			assert.match(err.message, /65535/);
			return true;
		},
	);
});

test("buildFrame acepta un cuerpo justo en el limite", () => {
	const justo = Buffer.alloc(MAX_FRAME_BODY - 2, 0x61); // -2: prefijo del frame DATA
	const frame = buildFrame(FRAME.DATA, justo, FRAME.FLAG_CLIENT);
	assert.equal(frame.readUInt16LE(3), MAX_FRAME_BODY);
});

test("dividirPrompt: un prompt chico queda intacto", () => {
	const partes = dividirPrompt("hola mundo", MAX_PROMPT_BYTES);
	assert.deepEqual(partes, ["hola mundo"]);
});

test("dividirPrompt: un prompt enorme se parte y no se pierde texto", () => {
	const original = Array.from({ length: 9000 }, (_, i) => `linea ${i} con texto de relleno para grewar`).join("\n");
	const partes = dividirPrompt(original, MAX_PROMPT_BYTES);
	assert.ok(partes.length > 1, "deberia partirse");
	for (const p of partes) {
		assert.ok(Buffer.byteLength(p, "utf8") <= MAX_PROMPT_BYTES, "ninguna parte puede pasar el tope");
	}
	assert.equal(partes.join("\n"), original, "al rearmar debe dar el texto original");
});

test("dividirPrompt: una linea mas grande que el tope se parte por caracteres", () => {
	const linea = "x".repeat(MAX_PROMPT_BYTES * 2 + 500);
	const partes = dividirPrompt(linea, MAX_PROMPT_BYTES);
	assert.ok(partes.length >= 3);
	for (const p of partes) assert.ok(Buffer.byteLength(p, "utf8") <= MAX_PROMPT_BYTES);
	assert.equal(partes.join(""), linea);
});

test("dividirPrompt: respeta el tope en bytes, no en caracteres (utf-8)", () => {
	const emojis = "🙂".repeat(MAX_PROMPT_BYTES); // 4 bytes por caracter
	const partes = dividirPrompt(emojis, MAX_PROMPT_BYTES);
	for (const p of partes) assert.ok(Buffer.byteLength(p, "utf8") <= MAX_PROMPT_BYTES);
});

test("piezaDeContexto: solo la ultima pieza pide la respuesta", () => {
	const medio = piezaDeContexto("parte 1", 0, 3);
	const final = piezaDeContexto("parte 3", 2, 3);
	assert.match(medio, /OK/);
	assert.ok(!/Responde ahora/.test(medio), "las partes intermedias no piden respuesta");
	assert.match(final, /Responde ahora/);
});

test("el envelope de un prompt de 40 KB entra en el frame", () => {
	const prompt = "a".repeat(MAX_PROMPT_BYTES);
	const { payload } = buildRequestPayload({
		prompt,
		conversationId: "11111111-2222-3333-4444-555555555555",
		userId: "1234567890",
	});
	const envelope = JSON.stringify({ "req-id": "req-test", payload: payload.toString("base64") });
	const frame = buildFrame(FRAME.DATA, envelope, FRAME.FLAG_CLIENT);
	assert.ok(frame.length <= MAX_FRAME_BODY + 6, `frame de ${frame.length} bytes`);
});

test("un turno con tool call NO es un turno vacio (el texto va vacio, el codigo no)", () => {
	// caso real: meta entrega la tool call en GenAICodeUXPrimitive y el texto
	// markdown queda vacio. Si se tomara por vacio, el hilo quedaria muerto.
	const conTool = {
		sections: [{
			view_model: {
				primitive: {
					__typename: "GenAICodeUXPrimitive",
					language: "json",
					code_blocks: [{ content: '{"tool":"read","arguments":{"path":"x"}}' }],
				},
			},
		}],
	};
	assert.equal(tieneCodigo(conTool), true, "la tool call cuenta como contenido");

	const soloTexto = {
		sections: [{
			view_model: { primitive: { __typename: "GenAIMarkdownTextUXPrimitive", text: "hola" } },
		}],
	};
	assert.equal(tieneCodigo(soloTexto), false, "un texto no es codigo, pero si es contenido");

	const vacio = { sections: [{ view_model: { primitive: { __typename: "GenAIMarkdownTextUXPrimitive", text: "" } } }] };
	assert.equal(tieneCodigo(vacio), false);
});

test("contrato de tools compacto: 20 tools con schema grande no revientan el frame", () => {	const tools = Array.from({ length: 20 }, (_, i) => ({
		type: "function",
		function: {
			name: `tool_${i}`,
			description: "descripcion larguisima ".repeat(40),
			parameters: {
				type: "object",
				properties: Object.fromEntries(
					Array.from({ length: 20 }, (_, j) => [`param_${j}`, { type: "string", description: "d".repeat(80) }]),
				),
				required: ["param_0"],
			},
		},
	}));
	const contrato = toolsContract(tools);
	assert.ok(contrato.length < 15_000, `contrato de ${contrato.length} chars`);
	assert.match(contrato, /param_0:string/);
	assert.match(contrato, /param_19:string\?/);
});
