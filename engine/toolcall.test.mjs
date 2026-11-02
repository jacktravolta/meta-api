// toolcall.test.mjs — bloques tool_call multiples y parseo de llamadas.
//
// Ejecutar: node --test engine/toolcall.test.mjs
//
// Contexto (dumps en vivo del 2026-11-01): meta manda las llamadas como
// primitivas GenAICodeUXPrimitive SEPARADAS, una por llamada, y una misma
// respuesta puede traer 4+ en paralelo (dump meta-41). Ademas repite la
// primitiva identica en varias secciones y a veces manda una rota con la
// cola duplicada (dump meta-6). El codigo viejo colapsaba por lenguaje y
// cortaba en la primera fuente valida: se perdia todo menos una llamada.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bloquesDe } from "./codigo.mjs";
import { parseToolCalls } from "./toolcall.mjs";

// espejo de la forma real de los dumps: primitiva de codigo dentro de secciones
const primitiva = (lang, content) => ({
	__typename: "GenAICodeUXPrimitive",
	language: lang,
	code_blocks: [{ content }],
});

const llamar = (tool, args) => JSON.stringify({ tool, arguments: args });

// ---------- bloquesDe ----------

test("bloquesDe: conserva las 4 primitivas tool_call de una respuesta en orden", () => {
	const respuesta = {
		sections: [
			{ view_model: { primitive: { __typename: "GenAITextPrimitive", text: "Reviso los archivos" } } },
			{ view_model: { primitive: primitiva("tool_call", llamar("read", { path: "server.mjs" })) } },
			// una mas profunda, como en los dumps reales (operations[].value.view_model.primitive)
			{ operations: [{ value: { view_model: { primitive: primitiva("tool_call", llamar("shell", { command: "ls -la" })) } } }] },
			{ view_model: { primitive: primitiva("tool_call", llamar("read", { path: "README.md" })) } },
			{ view_model: { primitive: primitiva("tool_call", llamar("glob", { pattern: "**/*.mjs" })) } },
		],
	};
	const bloques = bloquesDe(respuesta);
	assert.equal(bloques.length, 4);
	assert.deepEqual(bloques.map((b) => b.lang), ["tool_call", "tool_call", "tool_call", "tool_call"]);
	assert.deepEqual(bloques.map((b) => JSON.parse(b.code).tool), ["read", "shell", "read", "glob"]);
});

test("bloquesDe: la primitiva tool_call repetida identica se descarta", () => {
	const llamada = llamar("shell", { command: "ls -la" });
	const respuesta = {
		sections: [
			{ view_model: { primitive: primitiva("tool_call", llamada) } },
			{ view_model: { primitive: primitiva("tool_call", llamada) } },
			{ operations: [{ value: { view_model: { primitive: primitiva("tool_call", llamada) } } }] },
		],
	};
	assert.equal(bloquesDe(respuesta).length, 1);
});

test("bloquesDe: para los otros lenguajes sigue quedando el mas largo por lenguaje", () => {
	const respuesta = {
		sections: [
			{ view_model: { primitive: primitiva("python", "print(1)") } },
			{ view_model: { primitive: primitiva("python", 'print("una linea bastante mas larga que la primera")') } },
		],
	};
	const bloques = bloquesDe(respuesta);
	assert.equal(bloques.length, 1);
	assert.match(bloques[0].code, /bastante mas larga/);
});

test("bloquesDe: la variante tool_call: tambien cuenta como bloque de llamada", () => {
	const respuesta = {
		sections: [
			{ view_model: { primitive: primitiva("tool_call:", llamar("read", { path: "a.mjs" })) } },
			{ view_model: { primitive: primitiva("tool_call:", llamar("read", { path: "b.mjs" })) } },
		],
	};
	const bloques = bloquesDe(respuesta);
	assert.equal(bloques.length, 2);
});

// ---------- parseToolCalls ----------

test("parseToolCalls: 4 bloques en paralelo rinden 4 llamadas en orden", () => {
	const bloques = [
		{ code: llamar("read", { path: "server.mjs" }) },
		{ code: llamar("shell", { command: "ls -la" }) },
		{ code: llamar("read", { path: "README.md" }) },
		{ code: llamar("glob", { pattern: "**/*.mjs" }) },
	];
	const calls = parseToolCalls("", ["read", "shell", "glob"], bloques);
	assert.equal(calls.length, 4);
	assert.deepEqual(calls.map((c) => c.name), ["read", "shell", "read", "glob"]);
	assert.deepEqual(calls[0].arguments, { path: "server.mjs" });
});

test("parseToolCalls: un bloque roto no tira el resto (caso meta-6, cola duplicada)", () => {
	const roto = '{"tool": "read", "arguments": {"path": "a"}}}{"tool": "read", "arguments": {"path": "a"}}';
	const bloques = [{ code: roto }, { code: llamar("shell", { command: "ls" }) }];
	const calls = parseToolCalls("", ["read", "shell"], bloques);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "shell");
});

test("parseToolCalls: los bloques le ganan al fence del texto", () => {
	const bloques = [
		{ code: llamar("read", { path: "a.mjs" }) },
		{ code: llamar("shell", { command: "ls" }) },
	];
	const texto = `Vamos a mirar.\n\n\`\`\`json\n${llamar("glob", { pattern: "**/*" })}\n\`\`\`\n`;
	const calls = parseToolCalls(texto, ["read", "shell", "glob"], bloques);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((c) => c.name), ["read", "shell"]);
});

test("parseToolCalls: sin bloques cae al fence del texto (fallback historico)", () => {
	const texto = `texto antes\n\n\`\`\`tool_call\n${llamar("read", { path: "server.mjs" })}\n\`\`\`\ntexto despues`;
	const calls = parseToolCalls(texto, ["read"], []);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "read");
	assert.deepEqual(calls[0].arguments, { path: "server.mjs" });
});

test("parseToolCalls: la misma llamada repetida en dos bloques queda una sola vez", () => {
	const bloques = [
		{ code: llamar("read", { path: "a.mjs" }) },
		{ code: llamar("read", { path: "a.mjs" }) },
	];
	const calls = parseToolCalls("", ["read"], bloques);
	assert.equal(calls.length, 1);
});

test("parseToolCalls: filtra la llamada a una tool que el cliente no ofrecio", () => {
	const bloques = [
		{ code: llamar("python", { code: "print(1)" }) },
		{ code: llamar("read", { path: "a.mjs" }) },
	];
	const calls = parseToolCalls("", ["read"], bloques);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "read");
});
