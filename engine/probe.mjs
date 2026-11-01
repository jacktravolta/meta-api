// probe.mjs — conversacion con meta.ai por el gateway DGW, sin navegador.
//
//   node engine/probe.mjs "hola"                 -> usuario invitado (autonomo)
//   node engine/probe.mjs "hola" --session       -> usa engine/.session.json (tu cuenta)
//   META_ECTO_TOKEN=ecto1:... node engine/probe.mjs "hola"
//
// El token/cookies nunca se imprimen ni se commitean.

import { MetaGateway, GatewayError, CLOSE } from "./gateway.mjs";
import { getCredentials } from "./auth.mjs";
import * as session from "./session.mjs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const useSession = args.includes("--session");
const prompt = args.filter((a) => !a.startsWith("--"))[0];
if (!prompt) {
	console.error('uso: node engine/probe.mjs "mensaje" [--session]');
	process.exit(2);
}

let token = process.env.META_ECTO_TOKEN;
let cookies = null;
let userId = process.env.META_ABRA_USER_ID ?? null;

if (!token && useSession) {
	const s = session.load();
	if (!s) {
		console.error("sin sesion guardada en engine/.session.json (creala con engine/mirror-chat.mjs)");
		process.exit(2);
	}
	token = s.token;
	cookies = s.cookies;
	userId = userId ?? s.userId;
	console.error(`modo: sesion propia (capturada ${s.capturedAt})`);
}

if (!token) {
	console.error("modo: usuario invitado (autonomo, sin cuenta)");
	const creds = await getCredentials();
	token = creds.accessToken;
	userId = userId ?? creds.abraUserId;
	console.error(`invitado ${creds.abraUserId} | TOS ${creds.tosAccepted ? "aceptado" : "no"} | cache ${creds.cached ? "si" : "no"}`);
}

const gw = new MetaGateway({ token, cookies, userId, conversationId: randomUUID(), debug: process.env.META_DEBUG === "1" });

try {
	await gw.connect();
	console.error("gateway conectado (handshake 200)");
	console.log(`\n[TU] ${prompt}\n`);
	const { text } = await gw.chat(prompt, {
		onText: (acc) => process.stdout.write(`[META] ${acc.replace(/\n/g, "\n       ")}\n`),
	});
	console.log("\nTEXTO FINAL:", JSON.stringify(text));
	gw.close();
	process.exit(text ? 0 : 3);
} catch (err) {
	console.error("FALLO:", err.message);
	if (err instanceof GatewayError) {
		if (err.code === CLOSE.UNAUTHORIZED) console.error("=> token rechazado: rehacer credenciales (engine/auth.mjs o engine/session.mjs)");
		if (err.code === CLOSE.REJECTED || err.code === CLOSE.BAD_REQUEST) console.error("=> schema del pb rechazado: re-capturar y diff (TAREAS.md paso 5)");
	}
	if (process.env.META_DEBUG === "1") console.error(err.stack);
	process.exit(1);
}
