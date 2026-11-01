// probe-img.mjs — pide una imagen y vuelca TODOS los JSON del stream para
// descubrir como llega la imagen (url, media_id, primitives).
//   node engine/probe-img.mjs "genera una imagen de un gato naranja"
import fs from "node:fs";
import { MetaGateway } from "./gateway.mjs";
import * as session from "./session.mjs";

const s = session.load();
if (!s) { console.error("sin sesion"); process.exit(2); }
const gw = new MetaGateway({ token: s.token, cookies: s.cookies, userId: s.userId });
await gw.connect();

const out = [];
const t0 = Date.now();
const text = await gw.chat(process.argv[2] || "Genera una imagen de un gato naranja sentado.", {
	onJson: (j) => out.push(j),
	idleMs: 240_000,
});
console.log("texto:", JSON.stringify(text));
console.log("json frames:", out.length, "| ms:", Date.now() - t0);
const file = `/tmp/opencode/img-resp-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log("volcado:", file);

// resumen de primitives vistos
const types = new Set();
const walk = (o) => {
	if (!o || typeof o !== "object") return;
	if (typeof o.__typename === "string") types.add(o.__typename);
	for (const v of Object.values(o)) walk(v);
};
for (const j of out) walk(j);
console.log("tipos:", [...types].join(", "));
gw.close();
process.exit(0);
