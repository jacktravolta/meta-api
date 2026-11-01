// dgw-keys.mjs — analisis dirigido de la captura: extrae JSON embebidos y ubica el prompt
import fs from "node:fs";
const log = JSON.parse(fs.readFileSync("/tmp/opencode/capture-ws.json", "utf8"));
const buf = (b64) => Buffer.from(b64, "base64");

for (const fr of log.frames) {
	const b = buf(fr.data);
	if (b[0] !== 0x0d) continue;
	const s = b.toString("latin1");
	// JSON embebido: busca '{"' y parsea desde ahi (todas las posiciones)
	const outs = [];
	for (let i = s.indexOf("{"); i !== -1; i = s.indexOf("{", i + 1)) {
		for (let end = s.length; end > i; --end) {
			const txt = s.slice(i, end);
			if (txt.length < 10) break;
			try {
				const j = JSON.parse(txt);
				if (typeof j === "object") { outs.push({ i, j }); break; }
			} catch { continue; }
		}
	}
	console.log(`\n=== [${fr.dir}] ${b.length}b`);
	if (!outs.length) { console.log("  (sin JSON) primer hex:", b.slice(0, 24).toString("hex")); continue; }
	for (const o of outs) {
		const j = o.j;
		if (j["req-id"]) {
			console.log(`  req json @${o.i}: req-id=${j["req-id"]}`);
			if (j.payload) {
				const inner = buf(j.payload);
				const ppos = inner.indexOf(Buffer.from("responde solo: hola", "utf8"));
				console.log(`    payload b64-> ${inner.length}b; prompt utf8 @${ppos}`);
				console.log(`    primer hex: ${inner.slice(0, 40).toString("hex")}`);
				console.log(`    texto visible: ${inner.toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 500)}`);
			}
		} else if (j.seq !== undefined || j.sections || j.response) {
			console.log(`  seccion JSON @${o.i}:`);
			console.log(JSON.stringify(j, null, 1).slice(0, 2200));
		} else {
			console.log(`  otro json @${o.i}:`, JSON.stringify(j).slice(0, 200));
		}
	}
}
