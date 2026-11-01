// multichannel.mjs — emulacion MULTICANAL: varios usuarios/canales hablando a
// la vez con meta.ai, cada uno con su propio chat, durante N horas.
//
//   node engine/multichannel.mjs --minutes 60 --channels 3
//
// Cada canal:
//   - tiene su propio user_id + conversation_id (chat separado en tu cuenta)
//   - su propio director de conversacion (temas distintos)
//   - su propia conexion WS (pool del broker)
//   - una "prueba de memoria" cada 5 turnos: pregunta un dato que el mismo canal
//     guardo antes, para medir si el hilo conserva el contexto.
//
// Espejo: bridge/multichannel.txt (legible) y bridge/multichannel.jsonl.
// Al terminar imprime el informe por canal.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetaEngine } from "./broker-engine.mjs";
import { Director } from "./director.mjs";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TXT = path.join(ROOT, "bridge", "multichannel.txt");
const JSONL = path.join(ROOT, "bridge", "multichannel.jsonl");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const MINUTES = Number(arg("--minutes", 60));
const CHANNELS = Number(arg("--channels", 3));
const GAP_MIN = Number(arg("--gap-min", 60000));
const GAP_MAX = Number(arg("--gap-max", 180000));
const MODE = arg("--mode", "session");

fs.mkdirSync(path.dirname(TXT), { recursive: true });
fs.appendFileSync(TXT, `\n===== emulacion multicanal ${new Date().toISOString()} (${CHANNELS} canales, ${MINUTES} min, modo ${MODE}) =====\n`);

const mirror = (line) => {
	fs.appendFileSync(TXT, line + "\n");
	fs.appendFileSync(JSONL, JSON.stringify({ ts: new Date().toISOString(), line }) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// Dato que cada canal GUARDA en el turno 2 y se le PREGUNTA despues SIN
// revelarlo. La version anterior preguntaba "recuerda: la sala es la 7B,
// cual era?" — la respuesta viajaba dentro de la pregunta, asi que el modelo
// solo la repetia y el test daba un falso positivo.
const SECRETO = [
	{ store: "Guarda este dato: mi sala de reunion es la 7B. Responde solo 'ok'.", recall: "Cual es mi sala de reunion? Responde solo el codigo.", a: "7B" },
	{ store: "Guarda este dato: mi numero de ticket es TKT-8842. Responde solo 'ok'.", recall: "Cual es mi numero de ticket? Responde solo el codigo.", a: "TKT-8842" },
	{ store: "Guarda este dato: la clave de mi proyecto es AZUL-31. Responde solo 'ok'.", recall: "Cual es la clave de mi proyecto? Responde solo la clave.", a: "AZUL-31" },
	{ store: "Guarda este dato: el cliente de mi caso se llama Fantasma. Responde solo 'ok'.", recall: "Como se llama el cliente de mi caso? Responde solo el nombre.", a: "Fantasma" },
];

const engine = new MetaEngine({ mode: MODE === "session" ? "session" : "guest" });
const started = Date.now();
const deadline = started + MINUTES * 60_000;

const canales = Array.from({ length: CHANNELS }, (_, i) => ({
	id: `canal-${i + 1}`,
	userId: `user-${i + 1}`,
	channel: `demo-${i + 1}`,
	director: new Director({ seed: i }),
	secret: SECRETO[i % SECRETO.length],
	turnos: 0,
	errores: 0,
	renovaciones: 0,
	reconexiones: 0,
	memoriaOk: 0,
	memoriaFail: 0,
	memoriaCruce: 0,
	ultimo: null,
	turn: 0,
}));

mirror(`[sistema] arrancan ${CHANNELS} canales | duracion ${MINUTES} min | modo ${MODE}`);

async function correrCanal(c) {
	while (Date.now() < deadline) {
		const stamp = new Date().toISOString().slice(11, 19);
		let prompt;
		c.turn++;
		if (c.turn === 1) {
			prompt = c.director.next(null);
		} else if (c.turn === 2) {
			// se GUARDA el dato en un turno propio
			prompt = c.secret.store;
		} else if (c.turn % 5 === 0) {
			// prueba de memoria: la pregunta NO contiene la respuesta
			prompt = c.secret.recall;
		} else {
			prompt = c.director.next(c.ultimo);
		}
		try {
			const { text, conversationId, renewed, reconnect } = await engine.ask(prompt, {
				userId: c.userId,
				channel: c.channel,
			});
			c.turnos++;
			if (renewed) c.renovaciones++;
			if (reconnect) c.reconexiones++;
			c.ultimo = text;
			mirror(`[${stamp}] [${c.id}] YO   ${prompt}`);
			mirror(`[${stamp}] [${c.id}] META ${text}`);
			console.log(`[${stamp}] [${c.id}] ${text.slice(0, 90).replace(/\n/g, " ")}`);
			// evaluar la prueba de memoria (turno 5, 10, 15, ...): debe recordar
			// SU dato y no debe aparecer el dato de otro canal (cruce de hilos).
			if (c.turn % 5 === 0) {
				const U = (text ?? "").toUpperCase();
				const ok = U.includes(c.secret.a.toUpperCase());
				const ajenos = SECRETO.filter((s) => s !== c.secret).map((s) => s.a.toUpperCase());
				const cruce = ajenos.find((a) => U.includes(a)) ?? null;
				if (ok) c.memoriaOk++; else c.memoriaFail++;
				if (cruce) c.memoriaCruce++;
				mirror(`[${stamp}] [${c.id}] MEMORIA ${ok ? "OK" : "FALLA"} (esperado ${c.secret.a}${cruce ? `, CRUCE con ${cruce}` : ""}) | conv ${conversationId}`);
				console.log(`   [${c.id}] memoria: ${ok ? "OK" : "FALLA"} (esperaba ${c.secret.a}${cruce ? `, CRUCE ${cruce}` : ""})`);
			}
		} catch (err) {
			// un error NO debe tumbar la emulacion: se registra y el canal sigue
			c.errores++;
			mirror(`[${stamp}] [${c.id}] ERROR ${err?.message ?? err}`);
			console.error(`[${c.id}] error:`, err?.message ?? err);
			await sleep(20_000);
			continue;
		}
		await sleep(rand(GAP_MIN, GAP_MAX));
	}
}

console.log(`emulacion multicanal: ${CHANNELS} canales x ${MINUTES} min (modo ${MODE})`);
await Promise.all(canales.map(correrCanal));

const resumen = canales.map((c) => ({
	canal: c.id,
	usuario: c.userId,
	turnos: c.turnos,
	errores: c.errores,
	renovaciones: c.renovaciones,
	reconexiones: c.reconexiones,
	memoria_ok: c.memoriaOk,
	memoria_falla: c.memoriaFail,
	memoria_cruce: c.memoriaCruce,
}));
mirror(`[sistema] fin: ${JSON.stringify(resumen)}`);
console.log("\n=== INFORME MULTICANAL ===");
console.table(resumen);
fs.writeFileSync(path.join(ROOT, "bridge", "multichannel-resumen.json"), JSON.stringify({
	startedAt: new Date(started).toISOString(),
	finishedAt: new Date().toISOString(),
	minutes: MINUTES,
	channels: CHANNELS,
	mode: MODE,
	resumen,
}, null, 1));
engine.close();
process.exit(0);
