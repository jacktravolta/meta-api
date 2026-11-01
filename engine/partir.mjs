// partir.mjs — reparte un prompt que no entra en un frame DGW.
//
// El largo del frame va en un u16 (65535 bytes) y el envelope mete el protobuf
// en base64: un prompt de ~49 KB ya desborda. OpenCode manda el prompt de
// sistema + los schemas de sus tools + el historial en CADA turno, asi que
// esa situacion es la normal, no la excepcion.
//
// La solucion es la misma que usa el propio meta ("si no cabe entero, entrega
// la primera parte y di 'continua'"): el prompt se corta en trozos y cada
// trozo viaja como un turno seguido en el MISMO hilo. Meta conserva el
// contexto del lado del servidor, asi que al final ve el prompt completo.

/** Corta un texto en trozos de como mucho maxBytes, sin partir lineas. */
export function dividirPrompt(texto, maxBytes = 40_000) {
	const s = String(texto ?? "");
	const max = Math.max(1, Number(maxBytes) || 1);
	if (Buffer.byteLength(s, "utf8") <= max) return [s];

	const partes = [];
	let actual = "";
	for (const linea of s.split("\n")) {
		const cand = actual ? actual + "\n" + linea : linea;
		if (Buffer.byteLength(cand, "utf8") <= max) {
			actual = cand;
			continue;
		}
		if (actual) {
			partes.push(actual);
			actual = "";
		}
		if (Buffer.byteLength(linea, "utf8") <= max) {
			actual = linea;
			continue;
		}
		// una linea sola mas grande que el tope: se parte por caracteres
		for (const trozo of cortarPorBytes(linea, max)) {
			if (actual) {
				partes.push(actual);
				actual = "";
			}
			partes.push(trozo);
		}
	}
	if (actual) partes.push(actual);
	return partes.length ? partes : [s];
}

/** Corta por caracteres respetando el tope de BYTES (utf8 multi-byte). */
function cortarPorBytes(s, maxBytes) {
	const out = [];
	let resto = s;
	while (Buffer.byteLength(resto, "utf8") > maxBytes) {
		let lo = 1, hi = resto.length, mejor = 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (Buffer.byteLength(resto.slice(0, mid), "utf8") <= maxBytes) {
				mejor = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		out.push(resto.slice(0, mejor));
		resto = resto.slice(mejor);
	}
	if (resto) out.push(resto);
	return out;
}

/**
 * Envoltura de cada trozo para que meta no conteste por partes intermedias.
 * La ultima pieza es la que pide la respuesta.
 * @param {string} trozo
 * @param {number} i indice del trozo (0-based)
 * @param {number} total numero de trozos
 */
export function piezaDeContexto(trozo, i, total) {
	const ultima = i === total - 1;
	if (total === 1) return trozo;
	if (!ultima) {
		return [
			`CONTEXTO ${i + 1}/${total} (primera parte de un contexto largo).`,
			"Guarda esta informacion para responder despues. NO respondas nada ahora: responde solo la palabra OK.",
			"",
			trozo,
		].join("\n");
	}
	return [
		`CONTEXTO ${i + 1}/${total} (ULTIMA parte). Ya recibiste las partes anteriores en este mismo hilo.`,
		"Responde ahora a la peticion original teniendo en cuenta TODO el contexto recibido.",
		"",
		trozo,
	].join("\n");
}
