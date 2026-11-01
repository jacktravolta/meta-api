// codigo.mjs — extraccion del codigo que devuelve meta.
//
// Meta entrega el codigo en un primitive aparte (GenAICodeUXPrimitive) y lo
// va entregado por PATCHES: cada frame trae un trozo. El codigo COMPLETO
// esta en la respuesta ACUMULADA (el gateway aplica los parches), no en los
// frames sueltos.
//
// A veces, en vez de un bloque de codigo, meta entrega el archivo como
// artefacto incrustado en su front (el icono "<>"); para eso esta el
// fallback htmlEmbebido().

/** Bloques de codigo de una respuesta (el mas largo por lenguaje). */
export function bloquesDe(respuesta) {
	const out = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		if (o.__typename === "GenAICodeUXPrimitive" && Array.isArray(o.code_blocks)) {
			out.push({ lang: (o.language ?? "").toLowerCase(), code: o.code_blocks.map((b) => b.content ?? "").join("") });
		}
		for (const v of Object.values(o)) walk(v);
	};
	walk(respuesta);
	const mejor = new Map();
	for (const b of out) {
		if (!b.code.trim()) continue;
		const key = b.lang || "txt";
		const prev = mejor.get(key);
		if (!prev || b.code.length > prev.code.length) mejor.set(key, b);
	}
	return [...mejor.values()];
}

/** Documento HTML completo embebido en la respuesta (caso artefacto). */
export function htmlEmbebido(respuesta) {
	let mejor = null;
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		for (const v of Object.values(o)) {
			if (typeof v === "string" && v.length > 400 && /<!doctype html|<html/i.test(v)) {
				if (!mejor || v.length > mejor.length) mejor = v;
			} else walk(v);
		}
	};
	walk(respuesta);
	return mejor;
}

/**
 * Codigo completo de una respuesta.
 * @param {Array} jsons frames crudos (fallback)
 * @param {Object} respuesta respuesta acumulada del gateway (preferida)
 */
export function extraerCodigo(jsons = [], respuesta = null) {
	const deAcumulado = bloquesDe(respuesta);
	if (deAcumulado.length) return deAcumulado;
	const embebido = htmlEmbebido(respuesta);
	if (embebido) return [{ lang: "html", code: embebido, origen: "artefacto" }];
	const out = [];
	for (const j of jsons) out.push(...bloquesDe(j));
	const mejor = new Map();
	for (const b of out) {
		if (!b.code.trim()) continue;
		const key = b.lang || "txt";
		const prev = mejor.get(key);
		if (!prev || b.code.length > prev.code.length) mejor.set(key, b);
	}
	return [...mejor.values()];
}

/** El bloque mas largo (util cuando meta entrega un unico script generador). */
export function bloquePrincipal(bloques) {
	if (!bloques.length) return null;
	return [...bloques].sort((a, b) => b.code.length - a.code.length)[0];
}
