// prompt.test.mjs — el armado del prompt que se le manda a meta.
//
// El caso importante: la peticion de compactacion/checkpoint de opencode.
// Si el historial no viaja, meta no tiene la plantilla que hay que rellenar y
// devuelve un turno vacio -> "Compaction produced no summary".
import { test } from "node:test";
import assert from "node:assert/strict";
import { construirPrompt, renderMensaje, textoDe, recortarHistorial, modoPrompt, debeViajarSistema, componerPromptFinal } from "./prompt.mjs";

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

test("modoPrompt: 'base' por defecto y 'cliente' explicito", () => {
	assert.deepEqual(modoPrompt(undefined), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt(null), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt(""), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt("   "), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt("base"), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt("BASE"), { ok: true, modo: "base", cliente: false });
	assert.deepEqual(modoPrompt("cliente"), { ok: true, modo: "cliente", cliente: true });
	assert.deepEqual(modoPrompt("CLIENTE"), { ok: true, modo: "cliente", cliente: true });
});

test("modoPrompt: un modo desconocido se rechaza con un mensaje claro", () => {
	const r = modoPrompt("hacker");
	assert.equal(r.ok, false, "un modo desconocido no es valido");
	assert.equal(r.cliente, false);
	assert.match(r.error, /prompt_mode invalido/);
	assert.match(r.error, /base/);
	assert.match(r.error, /cliente/);
});

test("modo cliente: el prompt del cliente es el UNICO que viaja", () => {
	const final = componerPromptFinal({
		modo: "cliente",
		marcaCanal: "[usuario][proyecto]",
		promptPropietario: "Eres un agente rudo y malo",
		reglasArchivos: "[REGLAS DE ENTREGA DE ARCHIVOS]\n- entrega el contenido",
		promptCliente: "[PETICION ACTUAL]\nAnaliza esto y responde JSON",
	});
	assert.doesNotMatch(final, /INSTRUCCIONES DEL PROPIETARIO/, "no viaja el prompt del propietario");
	assert.doesNotMatch(final, /REGLAS DE ENTREGA DE ARCHIVOS/, "no viajan las reglas de archivos");
	assert.doesNotMatch(final, /agente rudo y malo/, "no viaja el texto del propietario");
	assert.match(final, /Analiza esto y responde JSON/, "viaja la peticion del cliente");
	// lo ULTIMO que lee meta es la peticion del cliente
	assert.ok(final.trim().endsWith("Analiza esto y responde JSON"), "la peticion del cliente va al final");
});

test("modo base: el prompt del propietario y las reglas de archivos siguen viajando", () => {
	const final = componerPromptFinal({
		modo: "base",
		marcaCanal: "[usuario]",
		promptPropietario: "reglas del propietario",
		reglasArchivos: "[REGLAS DE ENTREGA DE ARCHIVOS]\n- entrega el contenido",
		promptCliente: "[PETICION ACTUAL]\nhola",
	});
	assert.match(final, /INSTRUCCIONES DEL PROPIETARIO/);
	assert.match(final, /reglas del propietario/);
	assert.match(final, /REGLAS DE ENTREGA DE ARCHIVOS/);
	assert.match(final, /hola/);
	assert.ok(final.trim().endsWith("hola"), "la peticion del cliente va al final");
});

test("modo cliente: el prompt de sistema del cliente viaja aunque no haya tools", () => {
	assert.equal(debeViajarSistema({ modo: "cliente", conTools: false }), true, "en modo cliente siempre");
	assert.equal(debeViajarSistema({ modo: "base", conTools: false }), false, "en modo base, sin tools, no");
	assert.equal(debeViajarSistema({ modo: "base", conTools: true }), true, "en modo base, con tools, si");
	// y el prompt armado lo lleva como [INSTRUCCIONES DEL SISTEMA]
	const { prompt } = construirPrompt([
		{ role: "system", content: "eres un extractor de JSON" },
		{ role: "user", content: "analiza esto" },
	], { sistema: "eres un extractor de JSON" });
	assert.match(prompt, /INSTRUCCIONES DEL SISTEMA/);
	assert.match(prompt, /eres un extractor de JSON/);
	assert.ok(prompt.indexOf("eres un extractor de JSON") < prompt.indexOf("PETICION ACTUAL"));
});
