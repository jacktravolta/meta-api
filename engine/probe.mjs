// probe.mjs — prueba del gateway protocol-first contra meta.ai en vivo.
//
// Requiere un token ecto1: de una sesion autenticada REAL:
//   META_ECTO_TOKEN=<ecto1:...> node engine/probe.mjs "hola"
//
// El token se obtiene manualmente del usuario o de una cuenta dedicada
// (ver engine/TAREAS.md paso 1 y reglas de seguridad en paso 6).
// NUNCA pegues el token en el shell con historial abierto si es compartido.

import { MetaGateway, GatewayError, CLOSE } from "./gateway.mjs";
import { randomUUID } from "node:crypto";

const prompt = process.argv[2];
const token = process.env.META_ECTO_TOKEN;

if (!prompt) {
	console.error("uso: node engine/probe.mjs \"mensaje\"");
	process.exit(2);
}
if (!token) {
	console.error("falta META_ECTO_TOKEN en el entorno (paso 1 de TAREAS.md)");
	process.exit(2);
}

const conversationId = randomUUID();
const gw = new MetaGateway({ token, conversationId, debug: false });

try {
	await gw.connect();
	console.error(`conectado (conversation ${conversationId})`);
	const { text } = await gw.chat(prompt, {
		onText: (acc) => {
			process.stdout.clearLine?.(0);
			process.stdout.cursorTo?.(0);
			process.stdout.write(acc.replace(/\n/g, " \\n "));
		},
	});
	process.stdout.write("\n");
	console.log("TEXTO FINAL:", JSON.stringify(text));
	gw.close();
	process.exit(text ? 0 : 3);
} catch (err) {
	console.error("FALLO:", err.message);
	if (err instanceof GatewayError) {
		if (err.code === CLOSE.UNAUTHORIZED) console.error("=> consumo token invalido/expirado; buscar endpoint de interchange (TAREAS.md paso 1)");
		if (err.code === CLOSE.REJECTED || err.code === CLOSE.BAD_REQUEST) console.error("=> schema del pb fue rechazado; re-capturar y diff (TAREAS.md paso 5)");
	}
	process.exit(1);
}
