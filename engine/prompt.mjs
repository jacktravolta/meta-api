// prompt.mjs — arma el prompt que se le manda a meta a partir de los mensajes
// OpenAI del cliente.
//
// POR QUE EXISTE (causa raiz del error "Compaction produced no summary",
// medido el 2026-11-01):
//
// Meta no recibe un "historial de conversacion" como campo: el contexto llega
// DENTRO del prompt. La version anterior mandaba solo (a) el prompt de
// sistema recortado, (b) el contrato de tools y (c) el ultimo mensaje del
// usuario. El historial se quedaba en el lado del cliente.
//
// Con eso, una peticion de compactacion/checkpoint de opencode llegaba a meta
// como: "actualiza el checkpoint de arriba" SIN el checkpoint de arriba y SIN
// la plantilla que hay que rellenar. Meta respondio textualmente:
//
//   "I can't return the summary because no summary template was included in
//    this conversation. ... there is no template attached in this thread"
//
// y el cliente reportaba "Compaction produced no summary". El modelo no era el
// culpable: le faltaba la mitad de la peticion.
//
// REGLA: el prompt lleva (1) las instrucciones de sistema, (2) el contrato de
// tools, (3) TODO el historial en orden y (4) la peticion actual al final,
// para que la ultima cosa que lee meta sea lo que tiene que hacer.

/** Etiquetas por rol para el render del historial. */
const ETIQUETA = {
	user: "Usuario",
	assistant: "Asistente",
	tool: "Resultado de herramienta",
	system: "Instrucciones",
};

/** Texto de un mensaje (string o array de partes multimodal). */
export function textoDe(mensaje) {
	const c = mensaje?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => {
				if (typeof p === "string") return p;
				if (!p || typeof p !== "object") return "";
				if (typeof p.text === "string") return p.text;
				if (typeof p.content === "string") return p.content;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/** Render de un mensaje del historial. */
export function renderMensaje(m) {
	const texto = textoDe(m).trim();
	const rol = m?.role ?? "?";
	if (rol === "tool") {
		const nombre = m.name ?? m.tool_call_id ?? "herramienta";
		return `Resultado de ${nombre}:\n${texto}`;
	}
	if (rol === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
		const llamadas = m.tool_calls
			.map((c) => `[pide herramienta ${c?.function?.name ?? "?"}: ${c?.function?.arguments ?? "{}"}]`)
			.join("\n");
		return `Asistente:\n${texto}${texto ? "\n" : ""}${llamadas}`;
	}
	return `${ETIQUETA[rol] ?? rol}:\n${texto}`;
}

/** Indice del ultimo mensaje de usuario (-1 si no hay). */
function ultimoUsuario(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}
export { ultimoUsuario };

/**
 * Recorta un historial conservando los mensajes MAS RECIENTES (los antiguos
 * son los que menos importan y los que Meta ya tiene en su hilo).
 */
export function recortarHistorial(lineas, maxChars) {
	if (!maxChars || maxChars <= 0) return lineas;
	let total = lineas.reduce((n, l) => n + l.length + 2, 0);
	let i = 0;
	while (total > maxChars && i < lineas.length - 1) {
		total -= lineas[i].length + 2;
		i++;
	}
	if (i === 0) return lineas;
	const quitados = i;
	return [
		`[... ${quitados} mensajes antiguos del historial omitidos por el limite de contexto ...]`,
		...lineas.slice(i),
	];
}

/**
 * Modo de prompt: decide QUE instrucciones viajan a meta.
 *
 * - "base" (por defecto, o ausente): prompt del propietario + reglas de
 *   entrega de archivos + prompt del cliente. Es el modo historico.
 * - "cliente": SOLO viaja el prompt del cliente (su mensaje de sistema, su
 *   historial y su peticion). Para un cliente de API que trae su propio
 *   prompt: las instrucciones internas compiten con las suyas y el mensaje de
 *   sistema del cliente se perdia si no mandaba tools.
 *
 * @param {string|undefined|null} valor
 * @returns {{ok: boolean, modo: string, cliente: boolean, error?: string}}
 */
export function modoPrompt(valor) {
	const v = valor === undefined || valor === null ? "" : String(valor).trim().toLowerCase();
	if (!v) return { ok: true, modo: "base", cliente: false };
	if (v === "base") return { ok: true, modo: "base", cliente: false };
	if (v === "cliente") return { ok: true, modo: "cliente", cliente: true };
	return {
		ok: false, modo: "", cliente: false,
		error: `prompt_mode invalido: "${String(valor)}" (valores admitidos: "base", "cliente")`,
	};
}

/**
 * ¿Viaja el prompt de SISTEMA del cliente?
 * - modo "cliente": SIEMPRE (es el unico prompt que corre).
 * - modo "base": solo si el cliente trae tools (comportamiento historico:
 *   sin tools el mensaje de sistema se descartaba).
 */
export function debeViajarSistema({ modo = "base", conTools = false } = {}) {
	return modo === "cliente" || conTools === true;
}

/**
 * Compone el prompt FINAL que se le manda a meta.
 *
 * En modo "cliente" NO viajan las instrucciones del propietario ni las
 * reglas de entrega de archivos: solo el prompt del cliente (que ya termina
 * en [PETICION ACTUAL], ver construirPrompt).
 *
 * @param {{modo?: string, marcaCanal?: string, promptPropietario?: string,
 *          reglasArchivos?: string, promptCliente?: string}} partes
 * @returns {string}
 */
export function componerPromptFinal({
	modo = "base", marcaCanal = "", promptPropietario = "", reglasArchivos = "", promptCliente = "",
} = {}) {
	const cliente = modo === "cliente";
	const propio = String(promptPropietario ?? "").trim();
	const bloquePropietario = !cliente && propio
		? `[INSTRUCCIONES DEL PROPIETARIO]\n${propio}`
		: "";
	const reglas = cliente ? "" : String(reglasArchivos ?? "");
	return [marcaCanal, bloquePropietario, reglas, promptCliente]
		.filter((p) => (typeof p === "string" ? p.trim().length > 0 : !!p))
		.join("\n\n");
}

/**
 * Arma el prompt completo para meta.
 *
 * REGLA: el ULTIMO mensaje es la peticion (lo que hay que responder) y todo
 * lo anterior es historial (contexto). Asi funciona en los dos casos reales:
 *
 *   - compactacion/checkpoint: [system, checkpoint, peticion, instruccion]
 *     -> historial = checkpoint, peticion = instruccion (con la plantilla).
 *   - turno normal de agente: [system, peticion, tool_call, tool_result]
 *     -> historial = peticion + tool_call, peticion = tool_result.
 *
 * `instruccionFinal` permite que la ultima seccion NO sea el ultimo mensaje
 * sino una accion concreta (caso "continua el trabajo desde el checkpoint":
 * el checkpoint es contexto, no una pregunta que responder).
 *
 * @param {Array} messages mensajes de la request OpenAI
 * @param {{sistema?: string, contrato?: string, maxHistorial?: number, instruccionFinal?: string}} opts
 * @returns {{prompt: string, historial: string, peticion: string, recortado: boolean}}
 */
export function construirPrompt(messages, { sistema = "", contrato = "", maxHistorial = 120_000, instruccionFinal = "" } = {}) {
	const msgs = Array.isArray(messages) ? messages : [];
	const previos = msgs.slice(0, -1);
	const ultimo = msgs.length ? msgs[msgs.length - 1] : null;

	// El ultimo mensaje de sistema es el prompt de sistema del cliente (lo
	// pasa el llamador ya recortado): no se repite en el historial.
	let idxUltimoSystem = -1;
	for (let i = previos.length - 1; i >= 0; i--) {
		if (previos[i]?.role === "system") { idxUltimoSystem = i; break; }
	}
	const lineasCrudas = previos
		.map((m, i) => (i === idxUltimoSystem ? null : renderMensaje(m)))
		.filter((l) => l && l.trim().length > 0);

	// Con instruccionFinal, el ultimo mensaje es CONTEXTO (no peticion): pasa al
	// historial y la seccion final es la accion.
	if (instruccionFinal && ultimo) lineasCrudas.push(renderMensaje(ultimo));

	const lineas = recortarHistorial(lineasCrudas, maxHistorial);
	const historial = lineas.join("\n\n");
	const peticion = instruccionFinal || (ultimo ? renderMensaje(ultimo) : "");

	const partes = [];
	if (sistema) partes.push(`[INSTRUCCIONES DEL SISTEMA]\n${sistema}`);
	if (contrato) partes.push(`[HERRAMIENTAS DISPONIBLES]\n${contrato}`);
	if (historial) partes.push(`[HISTORIAL DE LA CONVERSACION]\n${historial}`);
	if (peticion) partes.push(`[PETICION ACTUAL]\n${peticion}`);

	return {
		prompt: partes.join("\n\n"),
		historial,
		peticion,
		recortado: lineas.length !== lineasCrudas.length,
	};
}
