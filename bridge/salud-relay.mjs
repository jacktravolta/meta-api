// salud-relay.mjs — WATCHDOG DEL RELAY.
//
// Por que existe: ningun supervisor miraba al relay. `salud-meta` mira la pagina
// de Meta cada 300 s (y su comentario dice 60), `vigia-wsp` mira la cola de
// pendientes, `errores-meta` mira la consola de Meta. Si wsp.mjs se cuelga,
// systemd lo ve "active", el log simplemente deja de avanzar y nadie se entera:
// hubo que abrir el chat a mano (caso real 2026-10-07 19:18-19:22, el relay
// quemando timeouts de CDP de 45 s encadenados mientras Chrome estaba apagado).
//
// Dos chequeos, cada 30 s:
//   1. CDP 9233 vivo. Si no, se levanta Chrome con el /warmup de meta-api
//      (meta-api lo arranca on-demand y no hay quien lo despierte solo).
//   2. El relay late. wsp.mjs escribe relay/state/wsp-latido.json en la primera
//      linea de cada vuelta del bucle; si el archivo tiene mas de 2 minutos, el
//      bucle esta CLAVADO en algun await y se reinicia el servicio.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = dirname(fileURLToPath(import.meta.url));
const LOG = join(BIN, "salud-relay.log");
const CDP = "http://127.0.0.1:9233";
const META = "http://127.0.0.1:8055";
const LATIDO = join(BIN, "..", "relay", "state", "wsp-latido.json");

const CADA_MS = 30000;          // cada cuanto se revisa
const SIN_LATIDO_MS = 120000;   // 2 min sin latido = el bucle esta clavado
const ENFRIAMIENTO_MS = 120000; // no reiniciar dos veces seguidas
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (m) => {
  const l = `[${new Date().toISOString()}] ${m}`;
  try { appendFileSync(LOG, l + "\n"); } catch {}
  console.log(l);
};
const sh = (c) => {
  try { return execFileSync("bash", ["-lc", c], { encoding: "utf8", timeout: 90000 }).trim(); }
  catch { return ""; }
};

const cdpVivo = async () => {
  try { const r = await fetch(`${CDP}/json/version`); return r.ok; } catch { return false; }
};
const leerLatido = () => {
  try { return JSON.parse(readFileSync(LATIDO, "utf8")); } catch { return null; }
};
const hayPestanaWsp = async () => {
  try {
    const l = await (await fetch(`${CDP}/json`)).json();
    return l.some((x) => (x.url || "").includes("web.whatsapp.com"));
  } catch { return false; }
};

let ultimoReinicio = 0;
log("salud-relay activo — vigilo CDP y el latido del relay");

for (;;) {
  try {
    if (!(await cdpVivo())) {
      // Sin Chrome el relay no puede leer ni enviar, y meta-api no lo levanta
      // solo: lo arranca on-demand y solo lo despierta una peticion suya.
      log(`CDP ${CDP} no responde: levanto Chrome con /warmup`);
      sh(`curl -s --max-time 90 ${META}/warmup >/dev/null 2>&1`);
      await sleep(10000);
      if (await cdpVivo()) {
        if (!(await hayPestanaWsp())) {
          log("sin pestana de WhatsApp: la reabro");
          // Con fetch y no con curl: el anidado de comillas en bash era fragil.
          try { await fetch(`${CDP}/json/new?${encodeURIComponent("https://web.whatsapp.com")}`, { method: "PUT" }); } catch {}
          await sleep(12000);
        }
        log("Chrome arriba de nuevo");
      } else {
        log("Chrome sigue sin responder tras el warmup");
      }
      continue;
    }

    const lat = leerLatido();
    const edad = lat ? Date.now() - Number(lat.ts || 0) : Infinity;
    if (edad > SIN_LATIDO_MS) {
      if (Date.now() - ultimoReinicio < ENFRIAMIENTO_MS) {
        log(`sin latido hace ${Math.round(edad / 1000)}s (enfriamiento, no reinicio todavia)`);
      } else {
        ultimoReinicio = Date.now();
        log(`el relay no late hace ${Math.round(edad / 1000)}s (ultimo ciclo ${lat ? lat.ciclo : "?"}): reinicio wsp.service`);
        sh("export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart wsp.service");
        await sleep(15000);
        const l2 = leerLatido();
        log(l2 && Date.now() - Number(l2.ts) < 30000 ? "relay reiniciado y latiendo" : "relay reiniciado (todavia sin latido nuevo)");
      }
    }
  } catch (e) {
    log("error en el chequeo: " + String(e).slice(0, 100));
  }
  await sleep(CADA_MS);
}
