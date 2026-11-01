// director.mjs — director de conversacion: genera los turnos siguientes de
// una conversacion natural con meta.ai.
//
// No es un guion fijo: cada turno se construye a partir del ULTIMO texto de
// meta (contexto real) y de pools de patrones rotativos, de modo que la
// conversacion se sostenga horas sin repetirse como un loro.

const TOPICS = [
	{
		topic: "meta-api y brokers OpenAI",
		opening: "Quiero contarte algo: estoy construyendo un broker que expone Meta AI como una API compatible con OpenAI. ¿Qué riesgos técnicos ves en mantener una sesión conversacional de larga duración contra un servicio así?",
		bridges: [
			"¿Qué pasa si el servidor reinicia la sesión a mitad de una respuesta larga?",
			"¿Cómo manejarías la idempotencia si el cliente reintenta el mismo mensaje?",
			"¿Qué métricas Argumentarías para un broker así?",
		],
		followups: [
			"Eso que mencionas de {f}, ¿en la práctica cómo lo resolverías tú?",
			"¿Y qué pasa con {f} cuando hay concurrencia?",
			"¿Hay alguna forma de detectar {f} temprano, antes de que rompa?",
			"Dame un ejemplo concreto de {f} en un caso de uso real.",
		],
	},
	{
		topic: "derecho chileno y documentos",
		opening: "Cambiando de tema: en Chile, ¿qué documentos suele pedir un juzgado de familia para un caso de pensión de alimentos, y cuál de ellos suele ser el más difícil de conseguir?",
		bridges: [
			"¿Y qué pasa cuando el documento no existe o está vencido?",
			"¿Qué debería hacer automáticamente un sistema que procesa esos documentos?",
			"¿Cómo le explicarías a una persona el riesgo de compartir un documento de forma online?",
		],
		followups: [
			"Con {f} en medio, ¿qué le dirías al usuario para que no se asuste?",
			"¿Y si {f} aparece con datos de un tercero?",
			"¿Cómo citarías {f} para que un abogado pueda verificarla?",
			"¿Qué error común se comete con {f} en estos casos?",
		],
	},
	{
		topic: "producto y empatía",
		opening: "Otra pregunta, esta vez de producto: en una app que cobra por créditos, ¿cómo comunicas que se acabaron sin que el usuario sienta que lo engañaron?",
		bridges: [
			"¿Y si el usuario se enoja igual?",
			"¿Qué notificaciones funcionan mejor en ese momento?",
			"¿Cómo lo medirías: conversión, abandono o algo distinto?",
		],
		followups: [
			"Con {f} de por medio, ¿qué tono usarías?",
			"¿Y si {f} no se puede resolver?",
			"Dame dos frases concretas que puedas decirle al usuario sobre {f}.",
			"¿Qué no dirías nunca sobre {f}?",
		],
	},
	{
		topic: "protocolos y redes",
		opening: "Hablemos de redes: cuando un cliente WebSocket te corta la conexión a mitad de un stream, ¿cuál es la forma más limpia de reconectar sin duplicar contenido?",
		bridges: [
			"¿Y si el servidor no te dice dónde quedó el corte?",
			"¿Cómo lo harías visible para quien opera el servicio?",
			"¿Qué tanto importa la diferencia entre perder un mensaje y perder una respuesta completa?",
		],
		followups: [
			"¿Y qué guardas para poder retomar después de {f}?",
			"¿Hay alguna forma estándar de manejar {f}?",
			"¿Qué pasa si {f} ocurre cada diez minutos?",
			"Explica con un ejemplo qué es {f} en la práctica.",
		],
	},
];

// Extrae un fragmento usable del ultimo texto para meterlo en la pregunta.
export function pickFragment(text) {
	if (!text) return null;
	const clean = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[*_`#>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
	const sentence = sentences[sentences.length - 1] ?? clean;
	const words = sentence
		.split(" ")
		.filter((w) => w.length > 5 && !/^(https?|www)$/i.test(w))
		.slice(0, 6);
	if (!words.length) return null;
	return words.slice(0, 3).join(" ").replace(/[.,;:]$/, "");
}

export class Director {
	constructor({ seed = 0 } = {}) {
		this.index = seed;
		this.topic = TOPICS[this.index % TOPICS.length];
		this.turn = 0;
		this.last = null;
		this.pattern = 0;
	}

	next(lastText) {
		if (lastText) this.last = lastText;
		this.turn++;
		if (this.turn === 1) return this.topic.opening;
		if (this.turn % 6 === 0) {
			this.index++;
			this.topic = TOPICS[this.index % TOPICS.length];
			return this.topic.opening;
		}
		const fragment = pickFragment(this.last);
		const pool = this.turn % 3 === 0 ? this.topic.bridges : this.topic.followups;
		const template = pool[this.pattern++ % pool.length];
		return template.replace("{f}", fragment ?? "ese punto");
	}
}

export { TOPICS };
