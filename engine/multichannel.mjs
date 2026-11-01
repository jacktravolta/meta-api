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

// dato que cada canal guarda para luego probar su memoria
const SECRETO = [
	{ q: "Para la reunion de hoy, la sala es la 7B. Guardalo y responde solo 'ok'.", a: "7B" },
	{ q: "El numero de ticket del proveedor es TKT-8842. Guardalo y responde solo 'ok'.", a: "TKT-8842" },
	{ q: "La clave del proyecto es AZUL-31. Guardalo y responde solo 'ok'.", a: "AZUL-31" },
	{ q: "El cliente del caso se llama Fantasma. Guardalo y responde solo 'ok'.", a: "Fantasma" },
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
		} else if (c.turn % 5 === 0) {
			// prueba de memoria: el canal debe recordar su propio dato
			prompt = `Sin contexto previo, recuerda: ${c.secret.q.replace("Guardalo y responde solo 'ok'.", "")} cual era? Una palabra.`;
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
			// evaluar la prueba de memoria
			if (c.turn % 5 === 0) {
				const ok = (text ?? "").toUpperCase().includes(c.secret.a.toUpperCase());
				if (ok) c.memoriaOk++; else c.memoriaFail++;
				mirror(`[${stamp}] [${c.id}] MEMORIA ${ok ? "OK" : "FALLA"} (esperado ${c.secret.a}) | conv ${conversationId}`);
				console.log(`   [${c.id}] memoria: ${ok ? "OK" : "FALLA"} (esperaba ${c.secret.a})`);
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
