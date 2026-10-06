// vigia-wsp.mjs — vigila la cola de invocaciones de WhatsApp.
// El relay (relay/wsp.mjs, WSP_AGENTE=1) NO contesta: encola cada invocacion
// "Don Bot" en relay/state/wsp-pendientes.txt. Este vigia detecta lineas nuevas,
// las imprime y SALE (una notificacion por mensaje), para que el agente de
// consola componga la respuesta y la publique con:
//     node relay/wsp.mjs --enviar "texto"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const BIN = dirname(fileURLToPath(import.meta.url));
const COLA = join(BIN, "..", "relay", "state", "wsp-pendientes.txt");
const MARCA = join(BIN, "wsp-vigia-marca.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LOCK: evita vigias duplicados (cada rearme dejaba zombis).
const LOCK = join(BIN, "vigia-wsp.lock");
try {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    if (pid && pid !== process.pid) { process.kill(pid, 0); console.log("ya hay un vigia-wsp vivo (pid " + pid + "); salgo"); process.exit(0); }
  }
} catch { /* libre */ }
try { writeFileSync(LOCK, String(process.pid)); } catch {}

const lineas = () => (existsSync(COLA) ? readFileSync(COLA, "utf8").split("\n").filter((l) => l.trim()) : []);
let marca = existsSync(MARCA) ? JSON.parse(readFileSync(MARCA, "utf8")) : null;

if (!marca) {
  // Primer arranque: linea base silenciosa.
  marca = { n: lineas().length };
  writeFileSync(MARCA, JSON.stringify(marca));
  console.log("== vigia-wsp activo (baseline: " + marca.n + " mensajes) ==");
} else {
  console.log("== vigia-wsp activo (marca: " + marca.n + ") ==");
}

for (let i = 0; i < 43200; i++) {
  const ls = lineas();
  if (ls.length > marca.n) {
    const nuevas = ls.slice(marca.n);
    marca.n = ls.length;
    writeFileSync(MARCA, JSON.stringify(marca));
    console.log("=== MENSAJE DE WHATSAPP (" + nuevas.length + ") ===");
    for (const l of nuevas) {
      try { const j = JSON.parse(l); console.log("  chat: " + j.chat + "\n  texto: " + j.texto); }
      catch { console.log("  " + l); }
    }
    process.exit(0);
  }
  await sleep(2000);
}
console.log("(vigia-wsp: 24 h sin mensajes)");
process.exit(0);
