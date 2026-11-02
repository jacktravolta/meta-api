// toolcall.mjs — soporte de tools (function calling) para la API OpenAI-compatible.
//
// Meta AI es un modelo de chat: no tiene function calling nativo. El unico canal
// es el texto. Pero el repo ya probó el patrón inverso en agent/tools.js: Meta
// emite un bloque de codigo con la llamada y el broker la ejecuta.
//
// Aqui se invierte: la tool la EJECUTA el cliente (OpenCode), no nosotros.
//   1. el proxy renderiza las tools de OpenAI como un CONTRATO de prompt
//   2. Meta responde con un bloque ```tool_call en JSON
//   3. el proxy lo convierte en tool_calls de OpenAI (delta.tool_calls en SSE)
//   4. OpenCode ejecuta la tool y devuelve el resultado (role:"tool")
//   5. el proxy reenvia el resultado a Meta y el hilo sigue
//
// Misma regla de encuadre que agent/tools.js (que funciona en vivo): NO se le
// dice "esta es una tool que debes llamar" (Meta se niega: "no es una
// herramienta real de mi sistema"), se le pide "escribi la llamada que
// queres que se ejecute".

const TAGS_OK = new Set(["", "json", "tool_call", "toolcall", "tool", "function"]);
const BLOCK_RE = /```([a-zA-Z0-9_+-]*)\s*([\s\S]*?)```/g;
const MAX_ARGS = 64 * 1024;
const MAX_DESC_CHARS = 240;

/**
 * Firma compacta de los argumentos: el nombre y el tipo de cada parametro.
 * El JSON Schema completo se lleva el 80% del frame (con 20 tools de opencode
 * el prompt pasaba de 60 KB) y meta no necesita las descripciones largas para
 * escribir la llamada.
 */
function firmaArgs(schema) {
	const props = schema?.properties ?? {};
	const required = new Set(schema?.required ?? []);
	const partes = Object.entries(props).map(([k, v]) => {
		const tipo = v?.type
			?? (Array.isArray(v?.anyOf) ? v.anyOf.map((x) => x?.type ?? "any").join("|") : "any");
		return `${k}:${tipo}${required.has(k) ? "" : "?"}`;
	});
	return partes.length ? partes.join(", ") : "(sin argumentos)";
}

/**
 * Contrato de prompt con las tools que el cliente ofrece.
 * @param {Array} tools tools OpenAI: [{type:"function", function:{name, description, parameters}}]
 */
export function toolsContract(tools, { forzado = null } = {}) {
	const lista = (tools ?? [])
		.map((t) => {
			const f = t?.function ?? t;
			if (!f?.name) return null;
			const schema = f.parameters ?? f.input_schema ?? { type: "object", properties: {} };
			const desc = (f.description ?? "").trim().replace(/\s+/g, " ");
			const descCorta = desc.length > MAX_DESC_CHARS ? desc.slice(0, MAX_DESC_CHARS) + "..." : desc;
			return `- ${f.name}: ${descCorta || "sin descripcion"}\n  argumentos: ${firmaArgs(schema)}`;
		})
		.filter(Boolean);
	if (!lista.length) return "";
	return `
---
Estoy trabajando con un proyecto y no tengo acceso a sus archivos ni a su sistema. Vos si: yo ejecuto las herramientas que me pidas y te pego su salida en el siguiente mensaje.

HERRAMIENTAS DISPONIBLES:
${lista.join("\n")}

Cuando necesites una, NO me lo expliques con palabras: escribi la llamada exacta y nada mas, dentro de un bloque de codigo con el tag \`\`\`tool_call:

\`\`\`tool_call
{"tool": "read", "arguments": {"path": "server.mjs"}}
\`\`\`

Si ya tenes lo que necesitas, responde con texto normal sin bloque de codigo.

IMPORTANTE: si tu respuesta necesita un dato del proyecto (un archivo, un listado, el contenido de una ruta), NO lo prometas ni lo narres: pedi la herramienta con el bloque tool_call. Frases como "Listemos la estructura" o "Voy a revisar el archivo" sin el bloque NO sirven: yo no puedo hacer nada por mi cuenta.
${forzado === "*"
	? "\nIMPORTANTE: en este turno TENES que llamar a una herramienta. No respondas con texto: solo el bloque tool_call."
	: forzado
		? `\nIMPORTANTE: en este turno TENES que llamar a la herramienta \`${forzado}\`. No respondas con texto: solo el bloque tool_call.`
		: ""}
`.trim();
}

/** Normaliza un objeto JSON de llamada a {name, arguments}. */
function normaliza(obj, nombres) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const name = String(obj.tool ?? obj.name ?? obj.function ?? "").trim();
	if (!name) return null;
	// solo tools que el cliente ofrecio: si no, no es una llamada nuestra
	if (nombres?.size && !nombres.has(name)) return null;
	let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? {};
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { args = { value: args }; }
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
	return { name, arguments: args };
}

/**
 * Extrae las tool calls de la respuesta de Meta.
 *
 * Meta responde con las llamadas en BLOQUES DE CODIGO (una primitiva
 * `tool_call` aparte POR llamada: en vivo se vieron respuestas con 4+ en
 * paralelo) y el texto markdown queda vacio; tambien puede venir en el
 * texto. Se procesa asi:
 *   1. TODOS los bloques de codigo que devuelve el motor (contenido JSON
 *      crudo): se acumulan las llamadas de cada uno; un bloque que no
 *      parsea NO aborta a los demas (dump meta-6: bloque con la cola
 *      duplicada) y las llamadas repetidas identicas se descartan.
 *   2. SOLO si ningun bloque rindio llamadas, se cae al fallback historico:
 *      el ultimo fence del texto (tag json/tool_call o sin tag) y despues
 *      el texto entero, si es JSON puro.
 *
 * @param {string} texto respuesta de meta (markdown)
 * @param {string[]} nombres tools ofrecidas (filtra llamadas ajenas)
 * @param {Array<{code:string}>} bloques bloques de codigo del motor
 */
export function parseToolCalls(texto, nombres = [], bloques = []) {
	const set = new Set(nombres);
	const out = [];
	const vistas = new Set();

	const empuja = (raw) => {
		if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return;
		let obj;
		try { obj = JSON.parse(raw); }
		catch {
			// a veces meta mete texto antes del JSON
			const m = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
			if (!m) return;
			try { obj = JSON.parse(m[1]); } catch { return; }
		}
		const arr = Array.isArray(obj) ? obj : [obj];
		for (const o of arr) {
			const n = normaliza(o, set);
			if (!n) continue;
			const args = JSON.stringify(n.arguments);
			if (args.length > MAX_ARGS) continue;
			// misma tool con los mismos argumentos dos veces es la misma llamada
			const huella = n.name + args;
			if (vistas.has(huella)) continue;
			vistas.add(huella);
			out.push(n);
		}
	};

	// 1) bloques de codigo del motor (el caso real: una primitiva tool_call
	//    por llamada). Un bloque roto se saltea, no corta el resto.
	for (const b of bloques ?? []) {
		empuja(String(b?.code ?? "").trim());
	}

	// 2) fallback historico: solo si NINGUN bloque rindio llamadas
	if (!out.length) {
		const src = String(texto ?? "");
		const fences = [...src.matchAll(BLOCK_RE)]
			.map((m) => ({ tag: String(m[1] ?? "").toLowerCase(), body: m[2] }))
			.filter((b) => TAGS_OK.has(b.tag));
		if (fences.length) empuja(fences[fences.length - 1].body.trim());

		// 3) el texto entero si es JSON
		if (!out.length) {
			const plano = src.trim();
			if (plano.startsWith("{") || plano.startsWith("[")) empuja(plano);
		}
	}
	return out;
}

/**
 * Convierte tool calls a la forma OpenAI (function calling).
 * @param {Array<{name:string, arguments:object}>} calls
 */
export function toOpenAiToolCalls(calls, idFactory = () => `call_${Math.random().toString(36).slice(2, 12)}`) {
	return (calls ?? []).map((c) => ({
		id: idFactory(),
		type: "function",
		function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
	}));
}

/**
 * Formatea para Meta los resultados que el cliente devolvio (role:"tool").
 * @param {Array} messages mensajes de la request OpenAI
 */
export function formatToolResults(messages) {
	const tools = (messages ?? []).filter((m) => m?.role === "tool");
	if (!tools.length) return "";
	const bloques = tools.map((m) => {
		const nombre = m.name ?? m.tool_call_id ?? "tool";
		const salida = typeof m.content === "string"
			? m.content
			: JSON.stringify(m.content ?? "");
		return `\`\`\`result ${nombre}\n${String(salida).trimEnd()}\n\`\`\``;
	});
	return `Salida de las herramientas que pediste:\n\n${bloques.join("\n\n")}\n\nContinua desde ahi.`;
}

/** Ultimo mensaje de sistema del cliente (instrucciones del agente). */
export function systemPrompt(messages) {
	const sys = (messages ?? []).filter((m) => m?.role === "system");
	if (!sys.length) return "";
	const ultimo = sys[sys.length - 1];
	const c = ultimo.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n").trim();
	return "";
}
