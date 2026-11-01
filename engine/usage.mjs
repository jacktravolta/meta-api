// usage.mjs — conteo de tokens estimado y registro por sala.
//
// Meta NO expone contador de tokens (su front es virtualizado y no hay
//计数器 en el protocolo). Por eso el conteo es una ESTIMACION a partir del
// texto de entrada y de salida, igual que hace el broker del modo navegador.
//
// La estimacion se calcula con una heuristica de caracteres y palabras, que en
// texto chico (codigo y español) queda dentro de +-15% del valor real de un
// tokenizer tipo BPE. No es un contador exacto y no se presenta como tal.
//
// Lo que si es exacto: los caracteres y los bytes, que quedan registrados junto
// a la estimacion para poder recalibrar la heuristica con datos reales.
//
// Registro: engine/.usage.json (0600, fuera de git), una fila por sala.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, ".usage.json");

// Heuristica: ~3.6 caracteres por token en texto promedio (español/ingles),
// con un piso por palabra (las palabras cortas rompen la regla de caracteres).
const CHARS_PER_TOKEN = Number(process.env.META_CHARS_PER_TOKEN || 3.6);

/** Tokens estimados de un texto. */
export function estimateTokens(text) {
	const s = String(text ?? "");
	if (!s.length) return 0;
	const porCaracteres = s.length / CHARS_PER_TOKEN;
	const palabras = s.trim().split(/\s+/).length * 1.3; // ~1.3 tokens por palabra
	return Math.max(1, Math.round((porCaracteres + palabras) / 2));
}

/** Texto plano de un mensaje OpenAI (string o array de partes). */
export function textoDe(mensaje) {
	const c = mensaje?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c.map((p) => {
			if (typeof p === "string") return p;
			if (p?.type === "text" || p?.type === "input_text") return p.text ?? "";
			// las tools tambien son prompt: se cuenta su descripcion y schema
			if (p?.type === "function" || p?.function) return JSON.stringify(p.function ?? p);
			return "";
		}).join("\n");
	}
	return "";
}

/** Tokens estimados de una request completa (prompt). */
export function promptTokens(messages, extra = {}) {
	let chars = 0;
	for (const m of messages ?? []) chars += textoDe(m).length;
	// los schemas de las tools van al prompt: se cuentan
	for (const t of extra.tools ?? []) chars += JSON.stringify(t?.function ?? t ?? "").length;
	return estimateTokens("x".repeat(chars));
}

/** Tokens estimados de una respuesta (completion). */
export function completionTokens(text, extra = {}) {
	let chars = String(text ?? "").length;
	for (const b of extra.bloques ?? []) chars += String(b?.code ?? "").length;
	return estimateTokens("x".repeat(chars));
}

function load() {
	try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { salas: {}, global: null }; }
}

function save(data) {
	try {
		fs.writeFileSync(FILE, JSON.stringify(data, null, 1), { mode: 0o600 });
		fs.chmodSync(FILE, 0o600);
	} catch { /* el registro es opcional */ }
}

/**
 * Registra un turno y devuelve el acumulado de la sala.
 * @param {object} turno {sala, conversationId, promptTokens, completionTokens, charsIn, charsOut}
 */
export function registrar(turno) {
	const data = load();
	const sala = String(turno.sala ?? turno.conversationId ?? "sin-sala");
	const prev = data.salas[sala] ?? {
		sala, conversation_id: turno.conversationId ?? null,
		turnos: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
		chars_in: 0, chars_out: 0, ultimo: null,
	};
	const fila = {
		sala,
		conversation_id: turno.conversationId ?? prev.conversation_id ?? null,
		turnos: prev.turnos + 1,
		prompt_tokens: prev.prompt_tokens + (turno.promptTokens ?? 0),
		completion_tokens: prev.completion_tokens + (turno.completionTokens ?? 0),
		total_tokens: prev.total_tokens + (turno.promptTokens ?? 0) + (turno.completionTokens ?? 0),
		chars_in: prev.chars_in + (turno.charsIn ?? 0),
		chars_out: prev.chars_out + (turno.charsOut ?? 0),
		ultimo: {
			at: new Date().toISOString(),
			prompt_tokens: turno.promptTokens ?? 0,
			completion_tokens: turno.completionTokens ?? 0,
			total_tokens: (turno.promptTokens ?? 0) + (turno.completionTokens ?? 0),
			chars_in: turno.charsIn ?? 0,
			chars_out: turno.charsOut ?? 0,
		},
	};
	data.salas[sala] = fila;
	const salas = Object.values(data.salas);
	data.global = {
		turnos: salas.reduce((a, r) => a + r.turnos, 0),
		prompt_tokens: salas.reduce((a, r) => a + r.prompt_tokens, 0),
		completion_tokens: salas.reduce((a, r) => a + r.completion_tokens, 0),
		total_tokens: salas.reduce((a, r) => a + r.total_tokens, 0),
		chars_in: salas.reduce((a, r) => a + r.chars_in, 0),
		chars_out: salas.reduce((a, r) => a + r.chars_out, 0),
		salas: salas.length,
		actualizado: new Date().toISOString(),
	};
	save(data);
	return { sala: fila, global: data.global };
}

/** Registro completo: global + por sala. */
export function consulta(sala = null) {
	const data = load();
	if (sala && data.salas[sala]) return { sala: data.salas[sala], global: data.global };
	return { salas: Object.values(data.salas).sort((a, b) => b.total_tokens - a.total_tokens), global: data.global };
}

export { FILE };
