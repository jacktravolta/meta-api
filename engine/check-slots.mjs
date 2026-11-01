// check-slots.mjs — deteccion y diagnostico de DRIFT del protocolo.
//
//   node engine/check-slots.mjs                 # revisa el fixture mas reciente
//   node engine/check-slots.mjs <captura.json>  # revisa una captura nueva
//
// Que hace:
//   1. decodifica el frame de envio (0x0d) de la captura;
//   2. lista TODAS las rutas del pb y sus valores (para comparar con el
//      contrato de PROTOCOL.md);
//   3. comprueba que las rutas que el motor sustituye siguen existiendo;
//   4. imprime el diff contra la captura anterior cuando hay una.
//
// Sirve para el runbook de drift: si Meta muta el envelope, este script dice
// QUE rutas cambiaron, sin adivinar.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrame, decodePb } from "./pb.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

// Rutas que engine/gateway.mjs sustituye en cada envio (ver insertSlots).
const SLOT_RUTAS = [
	"1.1.8.1", "1.1.8.2",   // player id
	"1.2.1", "1.2.2",       // account id
	"1.5.1", "1.5.3",       // timestamps de inicio de sesion/stream
	"1.6",                  // request id
	"1.10.1", "1.10.3", "1.10.4", // flow ids
	"2.1.1",                // turn id
	"2.1.2.1", "2.1.2.2", "2.1.2.3", // conversation id, ts, uniqueMessageId
	"2.1.5",                // flag de PRIMER mensaje (solo en el primero)
	"2.2",                  // PROMPT
	"2.4.1",                // indice del mensaje en el hilo
];

function frameDeEnvio(captura) {
	const frames = captura.frames ?? [];
	for (const f of frames) {
		if ((f.dir ?? f.direction) !== "sent" || !f.data) continue;
		const buf = Buffer.from(f.data, "base64");
		if (buf[0] !== 0x0d) continue; // 0x0f es el handshake, 0x0d el request
		const p = parseFrame(buf);
		const json = JSON.parse(p.payload.toString("utf8"));
		return Buffer.from(json.payload, "base64");
	}
	throw new Error("la captura no tiene frames de envio de request (0x0d)");
}

function rutas(nodes, prefijo = "pb") {
	const out = [];
	for (const n of nodes) {
		const ruta = `${prefijo}.${n.field}`;
		if (n.wire === 0) out.push([ruta, n.varint.toString()]);
		else if (n.kind === "str") out.push([ruta, JSON.stringify(n.str)]);
		else if (n.kind === "pb") out.push(...rutas(n.pb, ruta));
		else out.push([ruta, `bytes(${n.bytes.length})`]);
	}
	return out;
}

function cargar(archivo) {
	const captura = JSON.parse(fs.readFileSync(archivo, "utf8"));
	const pb = frameDeEnvio(captura);
	return { pb, mapa: new Map(rutas(decodePb(pb))) };
}

const arg = process.argv[2];
const objetivo = arg
	? path.resolve(arg)
	: (() => {
		const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
			.map((f) => path.join(FIXTURES, f))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		if (!files.length) throw new Error("sin fixtures en engine/fixtures/");
		return files[0];
	})();

console.log(`# revision de drift: ${objetivo}\n`);
const { pb, mapa } = cargar(objetivo);

console.log(`## Rutas del envelope (${mapa.size} nodos)\n`);
for (const [ruta, valor] of mapa) {
	const marcador = SLOT_RUTAS.includes(ruta.slice(3)) ? "  <-- SLOT" : "";
	console.log(`  ${ruta.padEnd(16)} = ${valor.slice(0, 78)}${marcador}`);
}

console.log(`\n## Slots que el motor necesita\n`);
let faltan = 0;
for (const ruta of SLOT_RUTAS) {
	const ok = mapa.has("pb." + ruta);
	if (!ok) faltan++;
	console.log(`  ${ok ? "OK  " : "FALTA"} ${ruta}${ok ? " = " + String(mapa.get("pb." + ruta)).slice(0, 50) : ""}`);
}
console.log(`\nslots faltantes: ${faltan}`);

if (mapan_mismatch(faltan)) process.exit(1);
function mapan_mismatch(n) { return n > 0; }

// diff contra la captura anterior (si hay otra)
const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
	.map((f) => path.join(FIXTURES, f))
	.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (files.length > 1 && files[1] !== objetivo) {
	const otra = cargar(files[1]);
	console.log(`\n## Diff contra ${path.basename(files[1])}\n`);
	const rutasA = new Set(otra.mapa.keys());
	const rutasB = new Set(mapa.keys());
	const nuevas = [...rutasB].filter((r) => !rutasA.has(r));
	const quitadas = [...rutasA].filter((r) => !rutasB.has(r));
	console.log(`  rutas nuevas:     ${nuevas.length ? nuevas.join(", ") : "(ninguna)"}`);
	console.log(`  rutas eliminadas: ${quitadas.length ? quitadas.join(", ") : "(ninguna)"}`);
	let cambios = 0;
	for (const [ruta, valor] of mapa) {
		if (!rutasA.has(ruta)) continue;
		if (String(otra.mapa.get(ruta)) !== String(valor)) {
			cambios++;
			if (cambios <= 25) {
				console.log(`  cambio ${ruta}: ${String(otra.mapa.get(ruta)).slice(0, 40)} -> ${String(valor).slice(0, 40)}`);
			}
		}
	}
	console.log(`  valores distintos: ${cambios} (los ids/timestamps cambian en cada envio; los que importan son los TIPOS y las rutas)`);
}
