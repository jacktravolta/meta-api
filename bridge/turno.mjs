// turno.mjs — contador de turnos del puente.
//   node turno.mjs        -> imprime el turno actual
//   node turno.mjs --inc  -> incrementa y imprime el nuevo
// El turno se estampa en cada mensaje registrado (turno|texto) para que el
// detector coteje por POSICION: un mensaje viejo replicado no coincide.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const F = join(BIN, "turno.json");
let n = 0;
try { n = existsSync(F) ? (JSON.parse(readFileSync(F, "utf8")).n || 0) : 0; } catch {}
if (process.argv.includes("--inc")) {
  n += 1;
  writeFileSync(F, JSON.stringify({ n, ts: new Date().toISOString() }));
}
console.log(n);
