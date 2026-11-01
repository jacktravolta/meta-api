// conversation.mjs — conversacion sostenida con meta.ai por el gateway DGW.
//
//   node engine/conversation.mjs --hours 9               # invitado (por defecto)
//   node engine/conversation.mjs --hours 9 --session     # tu cuenta (mas riesgo)
//   node engine/conversation.mjs --minutes 3 --verbose   # prueba corta
//
// Ritmo: espera de lectura segun el largo de la respuesta, tiempo de escritura
// segun el largo de la pregunta, intervalo variable entre mensajes y pausas
// largas ocasionales. No se martilla el servicio.
//
// Espejo: escribe en vivo en bridge/mirror-chat.txt (legible) y
// bridge/mirror-chat.jsonl (una linea por evento). Para ver el espejo:
//   tail -f bridge/mirror-chat.txt
//   node engine/mirror-pull.mjs 20      (ultimos 20 intercambios)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MetaGateway, GatewayError, CLOSE } from "./gateway.mjs";
import { getCredentials, clearCredentials } from "./auth.mjs";
import * as session from "./session.mjs";
import { Director } from "./director.mjs";
import { downloadImages } from "./media.mjs";
import { evento } from "./eventos.mjs";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MIRROR_TXT = path.join(ROOT, "bridge", "mirror-chat.txt");
const MIRROR_JSONL = path.join(ROOT, "bridge", "mirror-chat.jsonl");

const args = process.argv.slice(2);
const arg = (name, def) => {
	const i = args.indexOf(name);
	return i === -1 ? def : args[i + 1];
};
const has = (name) => args.includes(name);

const HOURS = Number(arg("--hours", 0));
const MINUTES = Number(arg("--minutes", 0));
const DURATION_MS = HOURS ? HOURS * 3600_000 : MINUTES ? MINUTES * 60_000 : 10 * 60_000;
const USE_SESSION = has("--session");
const VERBOSE = has("--verbose");
const MAX_GAP_MS = Number(arg("--max-gap", 900_000));
const DESCANSOS = has("--descansos");
// watchdog: si meta se queda mudo, se le manda "continua" (como en la web)
const WATCHDOG_MS = Number(arg("--watchdog", 150_000));
// pide una imagen en el turno N (del proceso actual) y la deja bajada en disco
// --imagen-al acepta una lista: "1,4" = pide imagen en el turno 1 y en el 4
const IMG_AL = String(arg("--imagen-al", "0")).split(",").map((n) => Number(n.trim())).filter((n) => n > 0);
const IMG_PROMPT = arg("--imagen-prompt",
  "Genera una imagen de un diagrama de arquitectura en estilo tecnico sobrio: un cliente OpenAI hablando con un broker propio, que a su vez se conecta a Meta AI por WebSocket. Sin texto, solo formas y flechas.");
const GAP_MIN_MS = Number(arg("--gap-min", 30_000));
const GAP_MAX_MS = Number(arg("--gap-max", 150_000));
const CDP_PORT = Number(arg("--cdp", 9298));

fs.mkdirSync(path.dirname(MIRROR_TXT), { recursive: true });
fs.appendFileSync(MIRROR_TXT, `\n===== conversacion iniciada ${new Date().toISOString()} (${USE_SESSION ? "sesion propia" : "invitado"}, ${Math.round(DURATION_MS / 60000)} min) =====\n`);

const mirror = (line) => {
	fs.appendFileSync(MIRROR_TXT, line + "\n");
	fs.appendFileSync(MIRROR_JSONL, JSON.stringify({ ts: new Date().toISOString(), line }) + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// Ritmo humano: leer la respuesta, redactar la pregunta, escribirla, pensar.
function paceAfterReply(replyText) {
	const words = (replyText ?? "").split(/\s+/).filter(Boolean).length;
	const readMs = Math.min(15000, 1500 + words * 45);          // leer la respuesta
	const thinkMs = rand(1200, 4200);                             // pausa antes de redactar
	const writeMs = Math.min(22000, 900 + words * 8);             // "escribir" el mensaje
	return readMs + thinkMs + writeMs;
}

function nextGapMs(replyText) {
	const words = (replyText ?? "").split(/\s+/).filter(Boolean).length;
	let gap = rand(GAP_MIN_MS, GAP_MAX_MS);
	// respuesta larga -> un poco mas de respiro (dentro de la ventana)
	if (words > 120) gap += rand(8000, 20000);
	// descanso ocasional (3-7 min) SOLO si se pide explicitamente: por defecto
	// el total se mantiene entre --gap-min y --gap-max.
	if (DESCANSOS && Math.random() < 0.12) gap += rand(180000, 420000);
	return Math.min(Math.max(gap, GAP_MIN_MS), GAP_MAX_MS);
}

let gateway = null;
let credentials = null;
const history = [];        // { prompt, reply } de todo lo conversado
let pendingContext = false; // al renovar credencial, el proximo turno lleva el resumen

/**
 * Resumen compacto de lo conversado, para que una credencial nueva no parta
 * de cero: los temas tocados + los ultimos intercambios (recortados).
 */
function buildContextNote() {
	if (!history.length) return "";
	const topics = [...new Set(history.map((h) => h.topic).filter(Boolean))];
	const last = history.slice(-6).map((h, i) => {
		const q = h.prompt.length > 160 ? h.prompt.slice(0, 160) + "…" : h.prompt;
		const a = (h.reply ?? "").replace(/\s+/g, " ").slice(0, 220);
		return `${i + 1}. Yo: ${q}\n   Meta: ${a}`;
	}).join("\n");
	return [
		"Contexto de nuestra conversacion anterior (continuamos el mismo hilo):",
		topics.length ? `Temas ya tratados: ${topics.join("; ")}.` : "",
		"Ultimos intercambios:",
		last,
		"Continua desde donde quedamos, sin repetir lo ya tratado.",
	].filter(Boolean).join("\n");
}

/** Pide una credencial nueva: invitado nuevo (HTTP) o recaptura de la sesion. */
async function renewCredentials() {
	if (USE_SESSION) {
		// la sesion propia solo se renueva mirando el WS del navegador
		await execFileAsync(process.execPath, [
			path.join(HERE, "capture-session.mjs"), String(CDP_PORT),
		], { timeout: 90_000 });
		const s = session.load();
		if (!s) throw new Error("no se pudo recapturar la sesion propia");
		mirror("[sistema] credencial de la sesion recapturada (misma cuenta, token nuevo)");
		return { token: s.token, cookies: s.cookies, userId: s.userId };
	}
	clearCredentials(); // el invitado cacheado caduco: se crea uno nuevo
	const c = await getCredentials();
	mirror(`[sistema] nuevo usuario invitado ${c.abraUserId} (el anterior caduco)`);
	return { token: c.accessToken, cookies: null, userId: c.abraUserId };
}

// Identidad del hilo: NO cambia al reconectar. Si el token caduca o la WS se
// cae, se abre una conexion nueva contra el MISMO conversation_id y se
// continua el hilo (ademas de inyectar el resumen como contexto).
let conversationId = randomUUID();
let depth = 0;
// puntero de hilo: SIN f2.1.4 el servidor usa el contexto activo de la cuenta
// y, al reconectar, el hilo se pierde o se cruza con otro chat.
let replyTo = null;
let messageIndex = 0;

// el reloj de la corrida (se ancla al inicio original si se reanuda)
let startedAt = Date.now();

// Estado del hilo en disco: un reinicio del runner (o un corte) retoma la MISMA
// conversacion en vez de empezar de cero. --resume lo carga; sin el, hilo nuevo.
const RUN_STATE = path.join(HERE, ".run-state.json");
function loadRunState() {
	try {
		const st = JSON.parse(fs.readFileSync(RUN_STATE, "utf8"));
		if (!st?.conversationId) return null;
		return st;
	} catch { return null; }
}
function saveRunState() {
	try {
		fs.writeFileSync(RUN_STATE, JSON.stringify({
			conversationId, replyTo, messageIndex, depth,
			startedAt, updatedAt: new Date().toISOString(),
		}, null, 1), { mode: 0o600 });
		fs.chmodSync(RUN_STATE, 0o600);
	} catch { /* el estado es opcional */ }
}
if (has("--resume")) {
	const st = loadRunState();
	if (st) {
		conversationId = st.conversationId;
		replyTo = st.replyTo ?? null;
		messageIndex = st.messageIndex ?? 0;
		depth = st.depth ?? 0;
		// el reloj de las 9 h NO se reinicia al reanudar: se ancla al inicio real
		if (st.startedAt) {
			startedAt = Date.parse(st.startedAt);
			const fin = startedAt + DURATION_MS;
			if (Date.now() >= fin) { console.log("--resume: la duracion ya se cumplio"); process.exit(0); }
			console.log(`reloj anclado al inicio original: ${new Date(startedAt).toISOString()} | termina ${new Date(fin).toISOString()}`);
		}
		console.log(`hilo reanudado: ${conversationId} | idx ${messageIndex} | replyTo ${replyTo ?? "-"}`);
	} else {
		console.log("--resume: no hay estado previo, hilo nuevo");
	}
}

async function ensureGateway() {
	if (gateway && !gateway.isClosed()) return gateway;
	if (USE_SESSION) {
		const s = session.load();
		if (!s) throw new Error("sin sesion guardada (engine/.session.json)");
		credentials = { token: s.token, cookies: s.cookies, userId: s.userId };
	} else {
		const c = await getCredentials();
		credentials = { token: c.accessToken, cookies: null, userId: c.abraUserId };
	}
	gateway = new MetaGateway({
		token: credentials.token,
		cookies: credentials.cookies,
		userId: credentials.userId,
		conversationId,
	});
	// el puntero de hilo sobrevive a la reconexion: replyTo = response_id del
	// ultimo turno e indice del mensaje. Si se reiniciaran, el mensaje se
	// enviaria como "primero" y el hilo perderia (o cruzaria) la memoria.
	gateway.depth = depth;
	gateway.replyTo = replyTo;
	gateway.messageIndex = messageIndex;
	await gateway.connect();
	mirror(`[sistema] conexion establecida (${USE_SESSION ? "sesion propia" : "invitado " + credentials.userId}) | hilo ${conversationId}`);
	return gateway;
}

async function send(prompt) {
	let lastError = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const gw = await ensureGateway();
			const t0 = Date.now();
			evento("PETICION", { conv: conversationId, idx: gw.messageIndex, reply_to: gw.replyTo, chars: prompt.length, prompt: prompt.replace(/\s+/g, " ").slice(0, 120) });
			const { text, images = [] } = await gw.chat(prompt, {
				watchdogMs: WATCHDOG_MS,
				watchdogPrompt: "continua",
				onWatchdog: (info) => {
					evento("WATCHDOG", { conv: conversationId, ms: info.ms, enviado: "continua" });
					mirror(`[sistema] meta se quedo callado ${Math.round(info.ms / 1000)}s: se le manda "continua"`);
				},
			});
			depth = gw.depth;
			replyTo = gw.replyTo;
			messageIndex = gw.messageIndex;
			saveRunState();
			// si Meta devuelve imagenes, se bajan (el CDN caduca) y se reflejan
			const bajadas = await downloadImages(images, { convId: conversationId });
			for (const b of bajadas) mirror(`[img] ${b.mime} ${b.bytes}B -> ${b.path}`);
			evento("RESPUESTA", { conv: conversationId, ms: Date.now() - t0, chars: (text ?? "").length, imagenes: bajadas.length, texto: (text ?? "").replace(/\s+/g, " ").slice(0, 120) });
			return text;
		} catch (err) {
			lastError = err;
			try { gateway?.close(); } catch { /* ignore */ }
			gateway = null;
			// token caducado (4003): se pide otro y se continua el hilo con el resumen
			if (err instanceof GatewayError && err.code === CLOSE.UNAUTHORIZED) {
				mirror("[sistema] el token caduco (4003): pidiendo uno nuevo y retomando el hilo");
				try {
					credentials = await renewCredentials();
					pendingContext = true;
					await sleep(rand(2000, 5000));
					continue;
				} catch (renewErr) {
					mirror(`[sistema] no se pudo renovar la credencial: ${renewErr.message}`);
					break;
				}
			}
			mirror(`[sistema] error (${err.message}) — reintento ${attempt + 1}/3`);
			await sleep(rand(4000, 9000));
		}
	}
	throw lastError;
}

const TOPIC_COUNT = 4;
const director = new Director({ seed: Math.floor(Math.random() * TOPIC_COUNT) });
let lastText = null;
let turns = 0;
let nextAt = Date.now() + rand(1500, 4000);

console.log(`conversacion iniciada: ${Math.round(DURATION_MS / 60000)} minutos | modo ${USE_SESSION ? "sesion propia" : "invitado"}`);
mirror(`[sistema] modo ${USE_SESSION ? "sesion propia" : "invitado"} | duracion ${Math.round(DURATION_MS / 60000)} min`);

while (Date.now() - startedAt < DURATION_MS) {
	const now = Date.now();
	if (now < nextAt) { await sleep(Math.min(nextAt - now, 30000)); continue; }

	let prompt = director.next(lastText);
	if (IMG_AL.includes(turns + 1)) {
		prompt = IMG_PROMPT;
		mirror(`[sistema] turno ${turns + 1}: se pide una imagen`);
	}
	// tras renovar la credencial, el hilo nuevo arranca con el resumen de lo
	// conversado: no se empieza de cero
	if (pendingContext) {
		const note = buildContextNote();
		if (note) {
			prompt = `${note}\n\n${prompt}`;
			mirror("[sistema] se inyecta el resumen del hilo previo en el nuevo turno");
		}
		pendingContext = false;
	}
	try {
		const reply = await send(prompt);
		turns++;
		lastText = reply;
		history.push({ prompt, reply, topic: director.topic.topic, ts: new Date().toISOString() });
		const stamp = new Date().toISOString().slice(11, 19);
		mirror(`[${stamp}] YO     ${prompt}`);
		mirror(`[${stamp}] META   ${reply}`);
		console.log(`\n[${stamp}] YO     ${prompt}`);
		console.log(`[${stamp}] META   ${reply}`);
		if (VERBOSE) console.log(`   (turno ${turns}, ${Math.round((Date.now() - startedAt) / 60000)} min)`);
	} catch (err) {
		mirror(`[sistema] turno fallido: ${err.message}`);
		console.error("turno fallido:", err.message);
	}

	nextAt = Date.now() + paceAfterReply(lastText) + nextGapMs(lastText);
}

mirror(`[sistema] conversacion finalizada: ${turns} turnos en ${Math.round((Date.now() - startedAt) / 60000)} min`);
console.log(`\nfinalizado: ${turns} turnos en ${Math.round((Date.now() - startedAt) / 60000)} minutos`);
try { gateway?.close(); } catch { /* ignore */ }
process.exit(0);
