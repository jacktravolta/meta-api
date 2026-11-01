// probe.mjs — prueba en vivo del engine protocol-first contra Meta AI real.
// Uso: node engine/probe.mjs "tu prompt"
// Si pasa un segundo argumento, lo envia al MISMO hilo para probar continuidad.

import { createSession } from "./abra.mjs";

const args = process.argv.slice(2);
const prompt = args[0] || "decime hola en una frase";
const followUp = args[1];

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const session = await createSession({ log });
const r1 = await session.send(prompt);
log("respuesta 1:");
console.log(r1.text);
console.error(`[conversationId=${r1.conversationId}]`);

if (followUp) {
	const r2 = await session.send(followUp);
	log("respuesta 2 (mismo hilo):");
	console.log(r2.text);
}
