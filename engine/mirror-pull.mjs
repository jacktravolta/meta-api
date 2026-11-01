// mirror-pull.mjs — muestra el espejo de la conversacion en curso.
//
//   node engine/mirror-pull.mjs [intercambios]   (default 10)
//
// Lee bridge/mirror-chat.jsonl y muestra los ultimos intercambios (pares
// YO/META) de forma compacta, para pegarlos en cualquier chat.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "bridge", "mirror-chat.jsonl");
const n = Number(process.argv[2] ?? 10);

if (!fs.existsSync(FILE)) {
	console.error("aun no hay espejo en", FILE);
	process.exit(1);
}

const lines = fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean)
	.map((l) => { try { return JSON.parse(l); } catch { return null; } })
	.filter(Boolean);

const turnos = [];
let actual = null;
for (const { ts, line } of lines) {
	if (/\bYO\s{2,}/.test(line)) {
		actual = { ts, yo: line.replace(/^\[[^\]]+\]\s*YO\s+/, "") };
		turnos.push(actual);
	} else if (/\bMETA\s{2,}/.test(line) && actual) {
		actual.meta = line.replace(/^\[[^\]]+\]\s*META\s+/, "");
	} else if (line.includes("[sistema]")) {
		turnos.push({ ts, sistema: line.replace(/^\[[^\]]+\]\s*/, "") });
	}
}

const ultimos = turnos.slice(-n);
for (const t of ultimos) {
	if (t.sistema) { console.log(t.sistema); continue; }
	console.log(`\n[${t.ts.slice(11, 19)}] YO   ${t.yo}`);
	console.log(`[${t.ts.slice(11, 19)}] META ${t.meta ?? "(sin respuesta)"}`);
}
console.log(`\n(${turnos.length} eventos en total — tail -f bridge/mirror-chat.txt)`);
