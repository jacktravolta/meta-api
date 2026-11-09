// gateway.test.mjs — tests golden contra las capturas reales sanitizadas.
// Ejecutar: node --test engine/gateway.test.mjs
//
// Si algo falla tras un cambio, NO se fuerza el resultado: es senal de drift
// de codigo propio o del protocolo (ver TAREAS.md paso 5).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FRAME, buildFrame, parseFrame, decodePb, encodePb, extractJsons,
} from "./pb.mjs";
import { buildRequestPayload, textOf, PROTOCOL, MetaGateway, textoTruncado, textoInacabado } from "./gateway.mjs";
import wsPkg from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const dec = (b64) => Buffer.from(b64, "base64");
const fixtures = fs.readdirSync(FIXTURES_DIR)
	.filter((f) => f.startsWith("capture-ws-") && f.endsWith(".json"))
	.sort();

test("hay fixtures de captura", () => {
	assert.ok(fixtures.length >= 1, "engine/fixtures debe tener capturas");
});

test("constantes de protocolo", () => {
	assert.equal(PROTOCOL.APP_ID, "1522763855472543");
	assert.equal(PROTOCOL.GATEWAY_URL, "wss://gateway.meta.ai/ws/clippy");
	assert.equal(PROTOCOL.AUTH_TYPE, "15:0");
});

for (const name of fixtures) {
	const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
	const fixture = JSON.parse(raw);
	const frames = fixture.frames.map((f) => ({ dir: f.dir, buf: dec(f.data) }));
	const parsed = frames
		.filter(({ buf }) => buf.length > 1)
		.map(({ dir, buf }) => ({ dir, ...parseFrame(buf) }));
	const sentFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_CLIENT);
	const recvFrames = parsed.filter((f) => f.type === FRAME.DATA && f.flag === FRAME.FLAG_SERVER);

	test(`${name}: regla de framing len = total - 6`, () => {
		for (const { dir, buf } of frames) {
			if (buf.length === 1) continue;
			assert.equal(buf.readUInt16LE(3), buf.length - 6, `frame ${dir} tipo 0x${buf[0].toString(16)}`);
		}
	});

	test(`${name}: frames reensamblados byte a byte`, () => {
		for (const { dir, buf } of frames) {
			if (buf.length === 1) continue;
			const p = parseFrame(buf);
			const rebuild = buildFrame(p.type, p.payload, p.prefix ?? p.flag);
			assert.ok(buf.equals(rebuild), `frame ${dir} tipo 0x${p.type.toString(16)} difiere`);
		}
	});

	test(`${name}: decodePb -> encodePb identico`, () => {
		assert.ok(sentFrames.length >= 1, "hay frame de envio");
		const sent = JSON.parse(sentFrames[0].payload.toString("utf8"));
		const captured = Buffer.from(sent.payload, "base64");
		assert.ok(captured.equals(encodePb(decodePb(captured))), "re-encode del pb capturado no es identico");
	});

	test(`${name}: el prompt esta en f2.2 y el texto se extrae del recv`, () => {
		const sent = JSON.parse(sentFrames[0].payload.toString("utf8"));
		const nodes = decodePb(Buffer.from(sent.payload, "base64"));
		const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
		assert.ok(msg, "field 2 anidado (mensaje)");
		const leaf = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str");
		assert.ok(leaf && leaf.str.length > 0, "prompt en f2.2");

		const texts = [];
		let sawPatch = false;
		for (const f of recvFrames) {
			for (const j of extractJsons(f.payload)) {
				if (j.type === "full" && j.response?.sections) {
					const t = textOf(j.response);
					if (t) texts.push(t);
				}
				if (j.type === "patch") {
					sawPatch = true;
					assert.ok(Array.isArray(j.operations), "patch trae operations[]");
				}
			}
		}
		assert.ok(texts.length >= 1, "se extrajo al menos un texto");
		assert.ok(sawPatch, "hay patch de control de fin de stream");
	});

	test(`${name}: fixture sin token real`, () => {
		assert.ok(!/ecto1[0-9A-Za-z._-]{20,}/.test(raw), "fixture sin token real");
	});
}

test("buildRequestPayload: slots por ruta, prompt y ids nuevos", () => {
	const CONV = "11111111-2222-4333-8444-555555555555";
	const TURN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const REQ = "eeeeeeee-ffff-4000-8111-222222222222";
	const { payload, replaced } = buildRequestPayload({
		prompt: "ping de prueba",
		conversationId: CONV,
		turnId: TURN,
		reqId: REQ,
		userId: "1234567890123456",
	});
	assert.ok(replaced >= 6, `slots replaced >= 6, got ${replaced}`);
	const text = payload.toString("latin1");
	assert.ok(text.includes("ping de prueba"), "prompt nuevo presente");
	assert.ok(text.includes(CONV), "conversation nueva presente");
	assert.ok(text.includes(TURN), "turn nuevo presente");
	assert.ok(text.includes(REQ), "req-id nuevo presente");
	assert.ok(text.includes("1234567890123456"), "user id presente");
});

test("buildRequestPayload con los mismos valores del template reproduce el original", () => {
	// el template es la captura mas reciente: sus ids se leen del fixture
	const newest = fixtures[fixtures.length - 1];
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, newest), "utf8"));
	const sentFrame = fixture.frames
		.map((f) => dec(f.data))
		.find((b) => b[0] === FRAME.DATA && b[7] === FRAME.FLAG_CLIENT);
	const sent = JSON.parse(sentFrame.subarray(8).toString("utf8"));
	const captured = Buffer.from(sent.payload, "base64");
	const nodes = decodePb(captured);
	const msg = nodes.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb");
	const prompt = msg.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "str").str;
	const turn = msg.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "str").str;
	const conv = msg.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 2 && n.wire === 2 && n.kind === "pb")
		.pb.find((n) => n.field === 1 && n.wire === 2 && n.kind === "str").str;

	const { payload } = buildRequestPayload({ prompt, conversationId: conv, turnId: turn, reqId: sent["req-id"] });
	// el re-encode puede diferir en los timestamps (se reescriben a "ahora")
	assert.equal(payload.length, captured.length, "mismo largo que el pb capturado");
});

test("segundo mensaje del hilo: f2.1.4 = respuesta previa y sin flags de primero", () => {
	// Ground truth: captura pair2 del 2026-11-01 (dos mensajes en el MISMO chat
	// del navegador). El front NO manda f2.1.5 ni f1.1.12.4 despues del primer
	// turno; en cambio agrega f2.1.4 = response_id de la respuesta anterior, que
	// es lo que ata el mensaje a SU hilo (sin el, los hilos se cruzan).
	const RID = "e.00qTayh62TA9unWI8vHEpLJmt";
	const CONV = "11111111-2222-4333-8444-555555555555";
	const { payload } = buildRequestPayload({
		prompt: "cual era mi codigo?",
		conversationId: CONV,
		reqId: "eeeeeeee-ffff-4000-8111-222222222222",
		replyTo: RID,
		messageIndex: 2,
		firstMessage: false,
	});
	const nodes = decodePb(payload);
	const find = (list, f) => list.find((n) => n.field === f);
	const f1 = find(nodes, 1);
	const f2 = find(nodes, 2);
	const inner = find(f2.pb, 1).pb;

	assert.equal(find(inner, 4)?.str, RID, "f2.1.4 lleva la respuesta anterior");
	assert.equal(find(inner, 5), undefined, "f2.1.5 (flag de primero) ausente");
	assert.equal(find(find(f2.pb, 4).pb, 1).str, "2", "f2.4.1 = indice del mensaje");
	assert.equal(find(find(f1.pb, 1).pb, 1).str, "KADABRA__CHAT__UNIFIED_INPUT_BAR");
	assert.equal(find(find(find(f1.pb, 1).pb, 12).pb, 4), undefined, "f1.1.12.4 ausente");
});

// --- DGW de mentira -------------------------------------------------------
// Reproduce la secuencia de frames MEDIDA el 2026-11-08 contra meta.ai:
//   full (preview "{\") -> deltas -> patch VACIO (LATIDO) -> mas deltas ->
//   frame FINAL (estado completo de la respuesta, ~1.4 s despues del latido).
// El latido NO es el fin del turno: cerrar ahi devolvia la respuesta cortada.

const RID = "e.testresponseid0001";
const WebSocketServer = wsPkg.WebSocketServer ?? wsPkg.Server;

const SECCION = (text) => ({
	view_model: { primitive: { __typename: "GenAIMarkdownTextUXPrimitive", text } },
});

const fullJson = (text) => ({
	type: "full",
	response_id: RID,
	response: { response_id: RID, sections: [SECCION(text)] },
});
const deltaJson = (value) => ({
	type: "patch",
	response_id: RID,
	operations: [{ op: "delta", path: "/sections/0/view_model/primitive/text", value }],
});
const latidoJson = () => ({ type: "patch", response_id: RID, operations: [] });
const finalJson = (text) => ({ response_id: RID, sections: [SECCION(text)] });

/** frame DATA del servidor: el payload es un pb con un leaf str = JSON */
function frameDe(obj) {
	const payload = encodePb([{ field: 1, wire: 2, kind: "str", str: JSON.stringify(obj) }]);
	return buildFrame(FRAME.DATA, payload, FRAME.FLAG_SERVER);
}

/** gateway DGW local que ejecuta el guion cuando llega el request del cliente */
async function dgwFalso(guion) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((res, rej) => { wss.once("listening", res); wss.once("error", rej); });
	const puerto = wss.address().port;
	wss.on("connection", (socket) => {
		socket.send(buildFrame(FRAME.HANDSHAKE, JSON.stringify({ code: 200 })));
		socket.on("message", (data) => {
			let f;
			try { f = parseFrame(Buffer.from(data)); } catch { return; }
			if (f.type !== FRAME.DATA) return; // es el request del cliente
			guion(socket);
		});
	});
	return { wss, url: `ws://127.0.0.1:${puerto}/` };
}

/** MetaGateway que habla con el DGW local en vez de con meta.ai */
class GatewayDePrueba extends MetaGateway {
	constructor(opts) { super(opts); this.urlLocal = opts.urlLocal; }
	url() { return this.urlLocal; }
}

async function turnoConGuion(guion) {
	const { wss, url } = await dgwFalso(guion);
	const gw = new GatewayDePrueba({ token: "ecto1:token-de-prueba", userId: "1", urlLocal: url });
	try {
		await gw.connect();
		const t0 = Date.now();
		const r = await gw.chat("analiza");
		return { r, ms: Date.now() - t0 };
	} finally {
		gw.close();
		await new Promise((res) => wss.close(res));
	}
}

test("textoTruncado: distingue el texto a medio camino del texto completo", () => {
	assert.equal(textoTruncado('{"'), true, "la preview de 2 chars esta truncada");
	assert.equal(textoTruncado('{"a": 1, "b": [1, 2'), true, "llaves sin cerrar");
	assert.equal(textoTruncado('{"a": "sin terminar'), true, "cadena sin terminar");
	assert.equal(textoTruncado("```json\n{\"a\": 1"), true, "bloque de codigo sin cerrar");
	assert.equal(textoTruncado('{"a": 1}'), false, "json completo");
	assert.equal(textoTruncado("[1, 2, 3]"), false, "lista completa");
	assert.equal(textoTruncado("Hola, todo listo."), false, "prosa normal");
	assert.equal(textoTruncado('No inventes datos: usa "comillas".'), false, "comillas balanceadas");
	assert.equal(textoTruncado("```json\n{\"a\": 1}\n```"), false, "json en bloque de codigo completo");
	assert.equal(textoTruncado(""), false, "vacio");
	assert.equal(textoTruncado(null), false, "null");
	assert.equal(textoTruncado(undefined), false, "undefined");
	assert.equal(textoTruncado(123), false, "no es texto");
});

test("textoInacabado: detecta la prosa que queda a medio camino", () => {
	// el caso real del 2026-11-09: la respuesta terminaba en el encabezado de
	// la lista y los bullets nunca llegaban
	assert.equal(textoInacabado("**1. En simple:**\n- WMS\n**2. Lo que te falta:**"), true, "etiqueta sin contenido");
	assert.equal(textoInacabado("Resumen del analisis:\n\n**Lo que te falta:**\n"), true, "etiqueta con salto de linea");
	assert.equal(textoInacabado("**2. Lo que te falta"), true, "negrita abierta");
	assert.equal(textoInacabado("Tus requisitos:\n- WMS\n-"), true, "item de lista vacio");
	assert.equal(textoInacabado("Tus requisitos:\n1."), true, "item numerado vacio");
	assert.equal(textoInacabado("## Resultados"), true, "titulo sin cuerpo");
	// respuestas normales: NO deben pagar latencia extra
	assert.equal(textoInacabado("Tu coincidencia es **42%**."), false, "negrita cerrada al final");
	assert.equal(textoInacabado("Lo que te falta:\n- SAP EWM\n- Power BI"), false, "lista completa");
	assert.equal(textoInacabado("¿Me pegas el CV y la oferta?"), false, "pregunta final");
	assert.equal(textoInacabado('{"match_score": 38}'), false, "json completo");
	assert.equal(textoInacabado(""), false, "vacio");
	assert.equal(textoInacabado(null), false, "null");
	assert.equal(textoInacabado(123), false, "no es texto");
});

test("el latido (patch vacio) NO cierra el turno: se espera el frame final", async () => {
	// secuencia medida: el latido cae en medio del texto y el frame final
	// (texto COMPLETO) llega despues.
	const COMPLETO = '{"nombre": "Juan Pérez González", "cargo_actual": "Operario de Bodega", "skills_tecnicas": ["WMS", "Excel"]}';
	const { r } = await turnoConGuion((socket) => {
		socket.send(frameDe(fullJson('{"')));
		socket.send(frameDe(deltaJson('nombre": "Juan Pérez González", "cargo_actual": "Operario de Bodega", ')));
		socket.send(frameDe(latidoJson()));
		setTimeout(() => {
			socket.send(frameDe(deltaJson('"skills_tecnicas": ["WMS", "Excel"]}')));
			socket.send(frameDe(finalJson(COMPLETO)));
		}, 120);
	});
	assert.equal(r.text, COMPLETO, "el turno debe cerrar con el texto COMPLETO, no con el cortado");
});

test("una respuesta que NO esta truncada sigue cerrando en el latido (sin esperar)", async () => {
	const TEXTO = "Hola, todo listo. Chau.";
	const { r, ms } = await turnoConGuion((socket) => {
		socket.send(frameDe(fullJson("Hola, todo listo.")));
		socket.send(frameDe(deltaJson(" Chau.")));
		socket.send(frameDe(latidoJson()));
		// si el motor esperase de mas, adoptaria este frame final
		setTimeout(() => socket.send(frameDe(finalJson("TEXTO QUE NO DEBE LLEGAR"))), 1200);
	});
	assert.equal(r.text, TEXTO, "la respuesta completa se devuelve tal cual");
	assert.ok(ms < 600, `no debe esperar al frame final (tardo ${ms}ms)`);
});

test("si el frame final trae menos texto, se conserva el acumulado (no se pierde contenido)", async () => {
	const ACUMULADO = '{"a": 1, "b": 2}';
	const { r } = await turnoConGuion((socket) => {
		socket.send(frameDe(fullJson('{"a": 1,')));
		socket.send(frameDe(latidoJson()));
		setTimeout(() => {
			socket.send(frameDe(deltaJson(' "b": 2}')));
			socket.send(frameDe(finalJson('{"a":1}')));
		}, 80);
	});
	assert.equal(r.text, ACUMULADO, "el texto mas largo gana: el acumulado");
});

test("un latido con la prosa a medio camino NO cierra el turno (la cola no se pierde)", async () => {
	// Regresion del 2026-11-09: el latido de meta cae sobre el encabezado de
	// una lista y el gateway cerraba el turno ahi. Los bullets que llegaban
	// despues se descartaban como "cola del turno anterior" y el usuario veia
	// la respuesta cortada.
	const CORTE = "**1. En simple:**\n- WMS\n**2. Lo que te falta:**";
	const COMPLETO = CORTE + "\n- SAP EWM\n- Power BI";
	const { r } = await turnoConGuion((socket) => {
		socket.send(frameDe(fullJson(CORTE)));
		socket.send(frameDe(latidoJson())); // el latido cae a medio camino
		setTimeout(() => {
			socket.send(frameDe(deltaJson("\n- SAP EWM\n- Power BI"))); // la cola llega despues
			socket.send(frameDe(finalJson(COMPLETO)));
		}, 80);
	});
	assert.equal(r.text, COMPLETO, "la cola del turno se conserva: la respuesta llega completa");
});

test("primer mensaje del hilo: flags de primero y sin f2.1.4", () => {
	const { payload } = buildRequestPayload({
		prompt: "primer mensaje",
		conversationId: "11111111-2222-4333-8444-555555555555",
		reqId: "eeeeeeee-ffff-4000-8111-222222222222",
		messageIndex: 0,
		firstMessage: true,
	});
	const nodes = decodePb(payload);
	const find = (list, f) => list.find((n) => n.field === f);
	const f1 = find(nodes, 1);
	const f2 = find(nodes, 2);
	const inner = find(f2.pb, 1).pb;

	assert.equal(find(inner, 4), undefined, "sin puntero en el primer mensaje");
	assert.equal(find(inner, 5)?.varint, 1n, "f2.1.5 = 1");
	assert.equal(find(find(f2.pb, 4).pb, 1).str, "0");
	assert.equal(find(find(f1.pb, 1).pb, 1).str, "KADABRA__HOME__UNIFIED_INPUT_BAR");
	assert.equal(find(find(find(f1.pb, 1).pb, 12).pb, 4).pb.find((n) => n.field === 1).varint, 1n, "f1.1.12.4 = 1");
});
