// prompt.test.mjs — el armado del prompt que se le manda a meta.
//
// El caso importante: la peticion de compactacion/checkpoint de opencode.
// Si el historial no viaja, meta no tiene la plantilla que hay que rellenar y
// devuelve un turno vacio -> "Compaction produced no summary".
import { test } from "node:test";
import assert from "node:assert/strict";
import { construirPrompt, renderMensaje, textoDe, recortarHistorial } from "./prompt.mjs";

test("el historial completo viaja en el prompt (caso compaction/checkpoint)", () => {
	const msgs = [
		{ role: "system", content: "instrucciones del agente" },
		{ role: "user", content: "<conversation-checkpoint>\nresumen anterior\n</conversation-checkpoint>" },
		{ role: "user", content: "explora proyecto" },
		{ role: "user", content: "Update the existing checkpoint into one consolidated summary.\nPLANTILLA:\n## Objective\n- ..." },
	];
	const { prompt, historial, peticion } = construirPrompt(msgs, { sistema: "instrucciones del agente" });
	assert.match(prompt, /conversation-checkpoint/, "el checkpoint anterior debe viajar");
	assert.match(prompt, /explora proyecto/, "el mensaje previo debe viajar");
	assert.match(prompt, /PLANTILLA/, "la plantilla debe viajar");
	assert.match(prompt, /PETICION ACTUAL/, "la peticion va al final");
	assert.match(historial, /conversation-checkpoint/);
	assert.match(peticion, /PLANTILLA/);
	// el checkpoint NO puede quedar solo en el historial: la peticion actual
	// es la instruccion de resumir, y el contenido a resumir va antes.
	assert.ok(prompt.indexOf("conversation-checkpoint") < prompt.indexOf("PETICION ACTUAL"));
});

test("el ultimo mensaje es la peticion y no se duplica en el historial", () => {
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "primero" },
		{ role: "assistant", content: "respuesta" },
		{ role: "user", content: "segundo" },
	];
	const { prompt, historial, peticion } = construirPrompt(msgs, { sistema: "sys" });
	assert.match(historial, /primero/);
	assert.match(historial, /respuesta/);
	assert.doesNotMatch(historial, /segundo/, "la peticion no va tambien en el historial");
	assert.match(peticion, /segundo/);
	assert.ok(prompt.indexOf("respuesta") < prompt.indexOf("PETICION ACTUAL"));
});

test("con resultados de tools, la peticion es el resultado y el resto es historial", () => {
	// caso normal del agente: el ultimo mensaje es el resultado de la tool.
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "lee el README" },
		{ role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: '{"filePath":"README.md"}' } }] },
		{ role: "tool", name: "read", content: "contenido del readme" },
	];
	const { prompt, historial, peticion } = construirPrompt(msgs, { sistema: "sys" });
	assert.match(historial, /lee el README/);
	assert.match(historial, /pide herramienta read/);
	assert.match(peticion, /Resultado de read/);
	assert.match(peticion, /contenido del readme/);
	assert.match(prompt, /contenido del readme/);
});

test("sin mensaje de usuario: el ultimo system es la peticion", () => {
	const msgs = [{ role: "system", content: "resume esto" }];
	const { prompt, peticion } = construirPrompt(msgs, { sistema: "sys" });
	assert.match(prompt, /resume esto/);
	assert.match(peticion, /resume esto/);
});

test("el historial se recorta por lo ANTIGUO y se avisa", () => {
	const msgs = [];
	for (let i = 0; i < 40; i++) msgs.push({ role: "user", content: `mensaje ${i} ` + "x".repeat(100) });
	msgs.push({ role: "user", content: "LA PETICION FINAL" });
	const { prompt, recortado } = construirPrompt(msgs, { maxHistorial: 1000 });
	assert.ok(recortado, "debe avisar que recorto");
	assert.match(prompt, /mensajes antiguos del historial omitidos/);
	assert.match(prompt, /LA PETICION FINAL/);
	assert.doesNotMatch(prompt, /mensaje 0 /, "los antiguos se van primero");
});

test("render de mensajes: roles, tool calls y contenido multimodal", () => {
	assert.match(renderMensaje({ role: "user", content: "hola" }), /^Usuario:/);
	assert.match(renderMensaje({ role: "assistant", content: "ok" }), /^Asistente:/);
	assert.match(renderMensaje({ role: "tool", name: "bash", content: "salida" }), /^Resultado de bash:/);
	assert.match(
		renderMensaje({ role: "assistant", content: "", tool_calls: [{ function: { name: "glob", arguments: "{}" } }] }),
		/pide herramienta glob/,
	);
	assert.equal(textoDe({ content: [{ type: "text", text: "parte" }] }), "parte");
	assert.equal(textoDe({ content: "plano" }), "plano");
});

test("recortarHistorial conserva el final", () => {
	const lineas = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
	const out = recortarHistorial(lineas, 150);
	assert.match(out[0], /omitidos/);
	assert.ok(out[out.length - 1].startsWith("c"));
});
