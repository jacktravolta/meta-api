// probe-tools.mjs — comprueba de donde sale la tool_call de meta:
// del texto markdown o de un bloque de codigo (GenAICodeUXPrimitive).
import fs from "node:fs";
import { MetaEngine } from "./broker-engine.mjs";
import { toolsContract, parseToolCalls } from "./toolcall.mjs";
import { extraerCodigo } from "./codigo.mjs";

const TOOLS = [{
	type: "function",
	function: {
		name: "read",
		description: "Lee un archivo del proyecto",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
}];

const prompt = [
	"Eres un agente de programacion. Lees archivos del proyecto.",
	toolsContract(TOOLS),
	"Lee el archivo engine/prompts.mjs y dime cuantas lineas tiene.",
].join("\n\n");

const engine = new MetaEngine({ mode: "session" });
const jsons = [];
const r = await engine.ask(prompt, { userId: "probe-tools", channel: "tools", onJson: (j) => jsons.push(j) });

console.log("text chars:", (r.text ?? "").length);
console.log("text:", JSON.stringify(r.text ?? "").slice(0, 400));
const bloques = extraerCodigo(jsons, r.response);
console.log("bloques de codigo:", bloques.length, bloques.map((b) => `${b.lang}:${b.code.length}`).join(", "));
for (const b of bloques) console.log("  bloque:", b.lang, JSON.stringify(b.code).slice(0, 300));

const llamadasTexto = parseToolCalls(r.text ?? "", ["read"]);
const llamadasBloque = bloques.flatMap((b) => parseToolCalls(b.code, ["read"]));
console.log("calls desde texto:", JSON.stringify(llamadasTexto));
console.log("calls desde bloques:", JSON.stringify(llamadasBloque));

fs.writeFileSync("/tmp/opencode/probe-tools-resp.json", JSON.stringify({ text: r.text, bloques, response: r.response }, null, 1));
process.exit(0);
