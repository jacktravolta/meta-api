// diag-vacio.mjs — captura cruda de un turno de meta con contrato de tools.
//   node engine/diag-vacio.mjs
// Deja el volcado en /tmp/opencode/diag-vacio.json para inspeccionar los
// frames crudos (el texto vacio con response_id viene de aqui).
import fs from "node:fs";
import { MetaEngine } from "./broker-engine.mjs";
import { toolsContract, parseToolCalls } from "./toolcall.mjs";
import { extraerCodigo } from "./codigo.mjs";

const tools = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file from the filesystem",
			parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
		},
	},
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		},
	},
];

const prompt = [
	"You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goal using the tools available to you.",
	toolsContract(tools),
	"Hola, responde en una sola frase: que puedes hacer?",
].join("\n\n");

const engine = new MetaEngine({ mode: "session" });
const jsons = [];
const r = await engine.ask(prompt, {
	userId: "diag-vacio",
	channel: "diag",
	onJson: (j) => jsons.push(j),
});

console.log("text chars:", (r.text ?? "").length);
console.log("text:", JSON.stringify(r.text ?? "").slice(0, 300));
const bloques = extraerCodigo(jsons, r.response);
console.log("bloques:", bloques.length, bloques.map((b) => `${b.lang}:${b.code.length}`).join(", "));
console.log("calls desde texto:", JSON.stringify(parseToolCalls(r.text ?? "", ["read", "bash"])));
console.log("calls desde bloques:", JSON.stringify(bloques.flatMap((b) => parseToolCalls(b.code, ["read", "bash"]))));
console.log("jsons crudos:", jsons.length);

fs.writeFileSync(
	"/tmp/opencode/diag-vacio.json",
	JSON.stringify({ text: r.text, bloques, jsons, response: r.response }, null, 1),
);
console.log("volcado en /tmp/opencode/diag-vacio.json");
process.exit(0);
