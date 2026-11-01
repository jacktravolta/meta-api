// mejorar-imagen.mjs — cadena de mejora de imagen contra meta.ai:
//
//   1. sube una imagen local al storage de meta (media_id)
//   2. le pide que la mejore
//   3. descarga lo que genero
//   4. vuelve a subir ESA imagen y se la pide mejorada otra vez
//   ... y asi N rondas.
//
//   node engine/mejorar-imagen.mjs <imagen> [--rondas 2] [--usuario img-mejora]
//
// Todo queda en un chat real de la cuenta (lo ves en el front de meta.ai) y
// las imagenes bajadas en engine/.media/<conversacion>/.

import fs from "node:fs";
import path from "node:path";
import { MetaEngine } from "./broker-engine.mjs";
import { evento } from "./eventos.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const entrada = args.find((a) => !a.startsWith("--") && args.indexOf(a) === 0) ?? args[0];
if (!entrada || !fs.existsSync(entrada)) {
	console.error("uso: node engine/mejorar-imagen.mjs <imagen> [--rondas 2] [--usuario x]");
	process.exit(2);
}
const RONDAS = Number(arg("--rondas", 2));
const USUARIO = arg("--usuario", "img-mejora");
const CANAL = arg("--canal", "c1");

const P1 = arg("--prompt", null);
const P2 = arg("--prompt2", null);
const PROMPT = (n) => {
	if (n === 1 && P1) return P1;
	if (n >= 2 && P2) return P2;
	return [
		"Mejora esta imagen.",
		n > 1 ? `Esta es la ronda ${n}: mejora la version anterior.` : "",
		"Contexto: es un diagrama de arquitectura de un broker que expone Meta AI como API compatible con OpenAI.",
		"Mejoras concretas: mas legible, mas contraste, textos mas cortos, flujo mas claro.",
	].filter(Boolean).join(" ");
};

const engine = new MetaEngine({ mode: "session" });
let actual = { path: path.resolve(entrada), nombre: path.basename(entrada) };

try {
	for (let ronda = 1; ronda <= RONDAS; ronda++) {
		const t0 = Date.now();
		console.log(`\n── ronda ${ronda} ── subiendo ${actual.nombre} (${fs.statSync(actual.path).size} bytes)`);
		const r = await engine.ask(PROMPT(ronda), {
			userId: USUARIO,
			channel: CANAL,
			attachments: [{ data: actual.path, filename: actual.nombre }],
		});
		console.log(`   respuesta: ${JSON.stringify((r.text ?? "").slice(0, 180))}`);
		console.log(`   imagenes: ${r.images.length} | chat: ${r.conversationId} | ${Date.now() - t0} ms`);
		evento("RONDA_IMAGEN", { ronda, usuario: USUARIO, conv: r.conversationId, imagenes: r.images.length, entrada: actual.nombre });

		if (!r.images.length) { console.log("   (meta no genero imagen: fin de la cadena)"); break; }
		const mejor = r.images[0];
		console.log(`   bajada: ${mejor.path} (${mejor.bytes} bytes, ${mejor.mime})`);
		// la siguiente ronda parte de la imagen recien generada
		actual = { path: mejor.path, nombre: path.basename(mejor.path) };
	}
} catch (err) {
	console.error("ERROR:", err?.message ?? err);
	process.exitCode = 1;
} finally {
	engine.close();
}
