// cleanup-chats.mjs — borra de la cuenta los chats creados por las pruebas.
//
//   node engine/cleanup-chats.mjs              # dry-run: solo lista
//   node engine/cleanup-chats.mjs --yes        # borra los chats identificados
//   node engine/cleanup-chats.mjs --all --yes  # borra TODOS los chats de la cuenta
//
// La selección NO es "todo lo que hay": por defecto solo marca
//   1) los conversation_id registrados en engine/.conversations.json (los que
//      creó el motor protocol-first), y
//   2) los títulos que corresponden a las pruebas de este repo.
// Cualquier chat tuyo que no cumpla eso queda intacto (y se lista como ajeno).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetaGraphQL } from "./meta-graphql.mjs";
import * as session from "./session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, ".conversations.json");

const args = process.argv.slice(2);
const YES = args.includes("--yes");
const ALL = args.includes("--all");

const s = session.load();
if (!s) {
	console.error("sin sesion propia: engine/capture-session.mjs");
	process.exit(2);
}
const gql = new MetaGraphQL({ token: s.token, cookies: s.cookies, abraUserId: s.userId });

// patrones de titulo de las pruebas de este repo
const PATRONES = [
	/la clave/i, /mi codigo de proyecto/i, /codigo de usuario/i, /color de marca/i,
	/que color/i, /que ves en esta imagen/i, /^di ok$/i, /^hola$/i, /dinero/i,
	/recordar la clave/i, /recordando la clave/i, /clave secreta/i, /clave de aquiles/i,
	/artefacto breaks/i, /ejemplo de break/i, /sala de la reunion/i, /numero de ticket/i,
	/responder con/i, /responder solo/i, /responde solo/i, /en una sola palabra/i,
	/quiero contarte algo/i, /cambiando de tema/i, /otra pregunta/i, /dame dos frases/i,
	/sin contexto previo/i, /demostr/i, /prueba/i, /test/i,
];

const store = (() => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } })();
const idsDelMotor = new Set(Object.values(store).map((v) => v?.convId).filter(Boolean));

const chats = await gql.conversations();
console.log(`chats en la cuenta: ${chats.length}\n`);

const propios = [];
const ajenos = [];
for (const c of chats) {
	const titulo = c.title ?? "";
	const porId = idsDelMotor.has(c.conversationId);
	const porTitulo = PATRONES.some((r) => r.test(titulo));
	const ts = c.lastSendMessageTimestampMs ? new Date(c.lastSendMessageTimestampMs).toISOString().slice(0, 16).replace("T", " ") : "-";
	const linea = `${(c.conversationId || "").slice(0, 8)} | ${ts} | ${titulo.slice(0, 52) || "(sin titulo)"}`;
	if (ALL || porId || porTitulo) propios.push({ ...c, motivo: porId ? "store" : "titulo" });
	else ajenos.push({ ...c, linea });
	console.log(`  ${ALL || porId || porTitulo ? "BORRAR" : "ajeno "} ${linea}`);
}

console.log(`\npropios: ${propios.length} | ajenos (intactos): ${ajenos.length}`);
if (!YES) {
	console.log("\ndry-run: no se borro nada. Repite con --yes para borrar los marcados.");
	process.exit(0);
}

let ok = 0;
let fail = 0;
for (const c of propios) {
	try {
		const r = await gql.deleteConversation(c.conversationId);
		const bien = r?.success === true || r?.__typename === "ConversationDeleted";
		if (bien) ok++; else fail++;
		console.log(`  ${bien ? "ok  " : "FALLA"} ${c.conversationId.slice(0, 8)} ${(c.title ?? "").slice(0, 40)}`);
	} catch (err) {
		fail++;
		console.log(`  ERROR ${c.conversationId.slice(0, 8)}: ${err.message.slice(0, 90)}`);
	}
	await new Promise((r) => setTimeout(r, 400));
}

console.log(`\nborrados: ${ok} | fallidos: ${fail}`);

// limpiar el registro local de los chats borrados
if (ok > 0) {
	const borrados = new Set(propios.map((c) => c.conversationId));
	const limpio = Object.fromEntries(Object.entries(store).filter(([, v]) => !borrados.has(v?.convId)));
	fs.writeFileSync(STORE, JSON.stringify(limpio, null, 1), { mode: 0o600 });
	fs.chmodSync(STORE, 0o600);
	console.log(`registro local: ${Object.keys(store).length} -> ${Object.keys(limpio).length} canales`);
}
process.exit(fail ? 1 : 0);
