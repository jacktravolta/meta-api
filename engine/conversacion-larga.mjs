// engine/conversacion-larga.mjs
//
// Conversacion humana y larga contra la API de meta-api (Meta AI), con TODO
// en un .txt para monitorizar en vivo con `tail -f`.
//
// Que es "humana" y no un ping-pong de pruebas:
//   * la persona tiene nombre (DANIEL) y habla en primera persona;
//   * cada tema tiene una cadena de preguntas encadenadas (preguntas de
//     seguimiento que dependen de la respuesta anterior), no mensajes sueltos;
//   * a veces la pregunta cita un fragmento de la respuesta anterior;
//   * hay entradillas, muletillas y pausas: el ritmo NO es de robot;
//   * la respuesta se "lee" a velocidad humana antes de la siguiente pregunta.
//
// El hilo se mantiene: se manda siempre el mismo user+project, asi que el
// broker reutiliza la misma conversacion de Meta y la memoria del hilo vive
// (por eso las preguntas de seguimiento tienen sentido).
//
// Uso:
//   node engine/conversacion-larga.mjs
//   HORAS=2 node engine/conversacion-larga.mjs            # duracion
//   LOG=/tmp/mia.txt node engine/conversacion-larga.mjs    # otro log
//   USUARIO=ana PROYECTO=prueba node engine/conversacion-larga.mjs
//
// Variables: API, HORAS, LOG, USUARIO, PROYECTO, CANAL, PAUSA_MIN, PAUSA_MAX.
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

const API = process.env.API || "http://127.0.0.1:8055";
const HORAS = Number(process.env.HORAS || 5);
const USUARIO = process.env.USUARIO || "daniel";
const PROYECTO = process.env.PROYECTO || "conversacion-larga";
const CANAL = process.env.CANAL || "default";
const PAUSA_MIN = Number(process.env.PAUSA_MIN || 45); // segundos entre turnos
const PAUSA_MAX = Number(process.env.PAUSA_MAX || 100);
// El motor NO corta por duracion total, sino por frames sin actividad: una
// respuesta larga (1000+ palabras) puede tardar varios minutos y sigue
// llegando bien. Peor caso REAL medido en el broker: Meta "se queda
// pensando" y el gateway corta por KEEPALIVE_TIMEOUT a los 300 s o 600 s
// (journal: "turno sin respuesta completa en 600000ms"), mas la espera en
// cola del modo serializado. Si el cliente aborta antes de ese punto deja
// un turno huerfano que traba el broker. Por eso el cliente aguanta 15 min:
// siempre gana el broker, nunca el cliente.
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 900000);

const sello = () => {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

const LOG = process.env.LOG || join(RAIZ, "state", `conversacion-larga-${sello()}.txt`);
mkdirSync(dirname(LOG), { recursive: true });

const HUMAN = USUARIO;
const BOT = "META AI";

// ── Temas: cadenas de preguntas que se siguen unas a otras ──────────────────
const TEMAS = [
  {
    // Arranca con la presentacion: da nombres y contexto para que las
    // preguntas de seguimiento mas adelante tengan sentido de verdad.
    titulo: "presentacion",
    turnos: [
      "Hola, soy Daniel. Vivo en Santiago y trabajo en una oficina. Hace rato que no me tomaba una conversación así para estas cosas. ¿Me echas una mano?",
      "Te cuento un poco más: tengo un perro que se llama Peumo, cumple 3 años mañana. ¿Qué se le puede regalar a un perro sin gastar una fortuna?",
      "Y mi pareja se llama Carla. Su cumple es el 25 de este mes. ¿Alguna idea de regalo que no sea perfume otra vez?",
      "Perfecto, gracias. Vamos a ir por partes, que quiero hacerla de a poco.",
    ],
  },
  {
    titulo: "vuelta al running",
    turnos: [
      "Buenos días. Quiero volver a correr 5 km después de dos años sin hacerlo y no sé por dónde partir. ¿Por dónde empezarías?",
      "Ok, y si sólo puedo entrenar tres veces por semana, ¿cómo lo ajusto?",
      "¿Y las rodillas? Me da algo de miedo volver a lesionarme, la última vez fue hace años.",
      "Mejor ir primero al physio, ¿cierto? ¿Qué le pregunto exactamente para no perder la hora?",
      "Perfecto, gracias. Una última cosa: ¿corro con podcast o mejor en silencio?",
    ],
  },
  {
    titulo: "bicicleta para la ciudad",
    turnos: [
      "Oye, estoy entre dos bicicletas para moverme por la ciudad. Una pesa 12 kg y la otra 9,5, y cuestan casi lo mismo. ¿Qué pesa más?",
      "Recorro unos 14 km al día, con una subida decente en el medio. ¿Cambia tu recomendación?",
      "¿Y los frenos? No quiero meterme en un susto en la bajada.",
      "Vale, y si le quiero agregar luces y un candado, ¿mejor guardo esos 40 mil para otra cosa?",
      "Me convenciste. ¿Qué revisaría antes de comprarla usada?",
    ],
  },
  {
    titulo: "cocina de la semana",
    turnos: [
      "Necesito organizar la comida de la semana. Trabajo solo y casi no cocino entre semana. ¿Por dónde empiezo?",
      "¿Qué se prepara rápido y aguanta bien en el refri?",
      "¿Y el desayuno? Ese sí lo necesito todos los días.",
      "Me gusta el eggs... sí, los huevos. ¿Los preparo el domingo para toda la semana?",
      "Genial. ¿Cuánto tiempo dura bien esa comida en el refri?",
    ],
  },
  {
    titulo: "viaje al sur",
    turnos: [
      "Estoy planificando cuatro días al sur con mi pareja. Primera vez que vamos tan al sur y no tenemos nada armado. ¿Qué me recomiendas?",
      "¿Vallegrande o Pucón? No queremos pasar los cuatro días en un solo lugar.",
      "¿Necesito un tag de auto para el sur? ¿O con la tarjeta normal basta?",
      "¿Qué se me puede estar olvidando para un viaje de auto en noviembre?",
      "Buenísimo. Una cosa más: ¿hay algún lugar que valga la desviatura cerca del lago?",
    ],
  },
  {
    titulo: "tocar guitarra",
    turnos: [
      "Quiero aprender a tocar guitarra y tengo tres meses antes de una boda donde tengo que tocar dos canciones. ¿Es realista?",
      "No tengo ninguna experiencia previa, sólo una guitarra que me regalaron hace años.",
      "¿Cuánto debería practicar al día para llegar a algo presentable?",
      "¿Qué canciones son más amables para un principiante? No quiero algo que suene a algo muy formal.",
      "¿Y si ensayo con alguien más? ¿Ayuda o estorba al principio?",
    ],
  },
  {
    titulo: "regalo para mi mamá",
    turnos: [
      "El cumple de mi mamá es en tres semanas y no tengo ni idea de qué regalarle. Le gusta mucho la cocina y las plantas.",
      "No quiero algo que sea sólo un objeto bonito. Algo que use de verdad.",
      "¿Y si le regalo la experiencia de un curso de cocina? ¿Le va a gustar o es muy impersonal?",
      "¿Cómo lo presento para que no se sienta como algo comprado?",
      "Me quedo con el curso. ¿Alguna última recomendación de dónde?",
    ],
  },
  {
    titulo: "computador lento",
    turnos: [
      "Mi notebook de hace seis años está terriblemente lenta. ¿Merece la pena arreglarla o debería comprar otra?",
      "Le puse más RAM, pero sigue igual de lento. El disco es de 500 GB.",
      "¿Y si le cambio el disco por uno SSD? ¿Cuánto se gana en la práctica?",
      "¿Vale la pena que lo lleve a un técnico o puedo hacerlo yo?",
      "Última pregunta: si al final decido comprar otra, ¿en qué me fijo?",
      "PD: el trabajo lo hago en casa la mitad de la semana, por si eso cambia algo. ¿O no?",
    ],
  },
  {
    titulo: "fotos del teléfono",
    turnos: [
      "Tengo 14 mil fotos en el teléfono, mezcladas con videos, y me quedé sin espacio. ¿Qué hago?",
      "¿Vale la pena pagar por almacenamiento en la nube o con un disco externo basta?",
      "¿Cómo respaldo sin estar horas pegado al computador?",
      "¿Y si quiero buscar una foto vieja sin abrirlas todas?",
      "Perfecto, gracias. Una duda boba: ¿las fotos se pueden ordenar solas por fecha y lugar?",
    ],
  },
  {
    titulo: "plan de ahorro",
    turnos: [
      "Quiero ahorrar para un viaje grande a Japón el año que viene, y no sé por dónde empezar con el dinero.",
      "Gano bastante variable. ¿Cómo se hace un plan que aguante los meses malos?",
      "¿Mismo dinero en la cuenta corriente con interés o en algo más riesgoso?",
      "¿Y en cuánto tiempo más o menos realista es juntar una cantidad decente?",
      "Me sirve. ¿Hay alguna app o planilla que me ayude a no perder el ritmo?",
    ],
  },
  {
    titulo: "notebook usado o nuevo",
    turnos: [
      "Estoy entre comprar un notebook nuevo o usado. El usado es la mitad y tiene un año de uso. ¿Qué me conviene?",
      "Lo necesito para trabajar y también para edición de video.",
      "¿Qué tengo que mirar para no comprar una bomba de tiempo?",
      "¿Y el tema de la batería? Es lo que más me asusta de los usados.",
      "Vale, si el precio del nuevo baja en enero, ¿espero o compro el usado ya?",
    ],
  },
  {
    titulo: "adoptar un gato",
    turnos: [
      "Llevo meses pensando en adoptar un gato. ¿Qué necesito saber antes de dar el paso?",
      "Vivo en un departamento pequeño y trabajo desde la casa. ¿Es buena idea?",
      "¿Cuánto cuesta mantenerlo al mes, más o menos? Quiero calcular el presupuesto real.",
      "¿Y si trabajo muchas horas fuera? ¿Se aburre o se adapta?",
      "¿Cómo elijo entre un gato de refugio y uno de una camada?",
    ],
  },
  {
    titulo: "dormir mejor",
    turnos: [
      "Último tema y prometo dejarte en paz: duermo mal, me despierto varias veces y al día siguiente voy arrastrado. ¿Qué puedo hacer?",
      "No es insomnio severo, es más bien que me acuesto cansado y despierto peor.",
      "¿La pantalla antes de dormir cuenta? Yo me acuesto con el teléfono a la mano.",
      "¿Y el ejercicio? Hago muy poco durante la semana.",
      "Voy a probar lo de la pantalla y lo de la hora fija. Gracias, en serio.",
    ],
  },
];

// Muletillas humanas: se anteponen o posponen para que no suene a formulario.
const ENTRADILLAS = [
  "", "", "", "", "oye, ", "oye una cosa: ", "jaja, ", "bueno, ",
  "perdona la insistencia: ", "oye, una duda más: ", "a ver, ",
];
const CIERRES = ["", "", "", " porfa", "¿?", " gracias", " vale, gracias", " (gracias de verdad)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (arr) => arr[Math.floor(Math.random() * arr.length)];
const entre = (a, b) => a + Math.random() * (b - a);

function escribir(txt) {
  const linea = txt.endsWith("\n") ? txt : txt + "\n";
  try { appendFileSync(LOG, linea); } catch (e) { console.error("no pude escribir en el log:", e.message); }
}

const ahora = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fechaLarga = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} -03`;
};

// Un fragmento legible de la respuesta anterior, para citarla.
function fragmento(texto) {
  const plano = String(texto || "").replace(/\s+/g, " ").trim();
  if (!plano) return "";
  return plano.length > 95 ? plano.slice(0, 95).replace(/\s+\S*$/, "") + "…" : plano;
}

// Cliente HTTP con node:http (NO fetch).
// Razon: el fetch de Node usa undici por debajo, que corta la conexion si
// los headers no llegan en 300 s (headersTimeout). Con el broker serializado
// un turno puede quedarse esperando mas de eso (Meta generating, cola del
// modo) y el cliente tiraba la conexion a los 5 min, dejando un turno
// huerfano. Con node:http el unico limite es TIMEOUT_MS.
const AGENTE = new http.Agent({ keepAlive: true, maxSockets: 2 });

function pedir(mensaje) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(`${API}/v1/chat/completions`);
    const cuerpo = JSON.stringify({
      model: "meta-ai",
      user: USUARIO,
      project: PROYECTO,
      channel: CANAL,
      messages: [{ role: "user", content: mensaje }],
      stream: false,
    });
    const req = http.request(
      {
        agent: AGENTE,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(cuerpo),
          "x-meta-user": USUARIO,
          "x-meta-project": PROYECTO,
          "x-meta-channel": CANAL,
          "x-meta-conversation": `${PROYECTO}:${USUARIO}`,
        },
      },
      (res) => {
        let crudo = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { crudo += c; });
        res.on("end", () => {
          clearTimeout(timer);
          let json = null;
          try { json = JSON.parse(crudo); } catch {}
          resolve({
            code: res.statusCode,
            json,
            crudo,
            ms: Date.now() - t0,
            retryAfter: res.headers["retry-after"],
          });
        });
      },
    );
    // Sin timeout de socket: el motor es quien corta el turno cuando debe.
    req.setTimeout(0);
    const timer = setTimeout(() => {
      req.destroy(new Error(`timeout del cliente (${TIMEOUT_MS / 1000} s)`));
    }, TIMEOUT_MS);
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 0, json: null, crudo: String(e?.message || e), ms: Date.now() - t0, error: true });
    });
    req.end(cuerpo);
  });
}

function textoRespuesta(res) {
  const c = res.json?.choices?.[0]?.message?.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (res.json?.error?.message) return `[error del broker] ${res.json.error.message}`;
  return "";
}

// ── Arranque ────────────────────────────────────────────────────────────────
const INICIO = Date.now();
const FIN = INICIO + HORAS * 3600 * 1000;
const HORA_FIN = new Date(FIN);

escribir("");
escribir("═".repeat(78));
escribir(`CONVERSACIÓN LARGA — ${BOT} (meta-api)`);
escribir("═".repeat(78));
escribir(`inicio                : ${fechaLarga()}`);
escribir(`duración planificada  : ${HORAS} h (hasta ~${String(HORA_FIN.getHours()).padStart(2, "0")}:${String(HORA_FIN.getMinutes()).padStart(2, "0")})`);
escribir(`API                   : ${API}`);
escribir(`sala                  : usuario=${USUARIO} proyecto=${PROYECTO} canal=${CANAL}`);
escribir(`ritmo                 : ${PAUSA_MIN}-${PAUSA_MAX} s entre turnos + pausas de lectura`);
escribir(`timeout por turno    : ${TIMEOUT_MS / 1000} s (el broker puede tardar hasta 10 min si Meta se queda pensando)`);
escribir("─".repeat(78));

console.log(`[conversacion-larga] log: ${LOG}`);
console.log(`[conversacion-larga] termina ~${HORA_FIN.toLocaleTimeString("es-CL")}`);

let turno = 0;
let ultimoTema = null;
let ultimaRespuesta = "";
let errores = 0;
let fallos = 0;
let lentos = 0;
let citas = 0;

const PARAR = { ahora: false };
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    PARAR.ahora = true;
    escribir("");
    escribir(`[${fechaLarga()}] señal ${sig} recibida: se corta la conversación.`);
  });
}

// Palabras que NO se pasan a minúscula aunque venga una entradilla delante:
// saludar en mayúscula es natural, "oye, buenos días" suena a robot.
const NO_PASAR_A_MINUSCULA = ["Buenos", "Hola", "Hey", "Ok", "Vale", "Perfecto", "Genial", "Buenísimo", "Buenísimo."];

// Construye el siguiente mensaje: base + entradilla + cita + cierre.
function construir(base) {
  let msg = base;
  const quiereCita = Math.random() < 0.35 && ultimaRespuesta;
  if (quiereCita) {
    const f = fragmento(ultimaRespuesta);
    if (f) {
      msg = azar([
        `Sobre "${f}": ${base.charAt(0).toLowerCase()}${base.slice(1)}`,
        `Lo que dijiste de "${f}"... ${base.charAt(0).toLowerCase()}${base.slice(1)}`,
        `Volviendo a lo de "${f}": ${base.charAt(0).toLowerCase()}${base.slice(1)}`,
      ]);
      citas++;
    }
  }
  // El primer turno es una presentacion: sin entradillas, en mayuscula.
  const entra = turno === 0 ? "" : azar(ENTRADILLAS);
  const sale = turno === 0 ? "" : azar(CIERRES);
  let final = `${entra}${msg}${sale}`.replace(/\s+/g, " ").trim();
  if (entra) {
    const primera = final.split(" ")[0].replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
    if (!NO_PASAR_A_MINUSCULA.includes(primera) && primera.length > 1) {
      const i = final.indexOf(primera);
      final = final.slice(0, i) + primera.charAt(0).toLowerCase() + primera.slice(1) + final.slice(i + primera.length);
    }
  }
  return final;
}

function barajar(a) {
  const c = [...a];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
}

// La presentacion va SIEMPRE primero (define nombre y contexto del personaje);
// el resto de los temas se baraja para que no suene a guion.
const presentacion = TEMAS.find((t) => t.titulo === "presentacion");
const resto = barajar(TEMAS.filter((t) => t !== presentacion));
let cola = presentacion ? [presentacion, ...resto] : barajar(TEMAS);
let indiceEnTema = 0;

while (!PARAR.ahora && Date.now() < FIN) {
  // Ubica el siguiente turno: mismo tema si quedan, si no, tema nuevo.
  if (!ultimoTema || indiceEnTema >= ultimoTema.turnos.length) {
    if (ultimoTema) {
      cola = barajar(cola.filter((t) => t !== ultimoTema));
      if (!cola.length) cola = barajar(TEMAS);
    }
    ultimoTema = cola[0];
    indiceEnTema = 0;
  }
  const base = ultimoTema.turnos[indiceEnTema++];
  const mensaje = construir(base);

  // Ritmo humano: "piensa" antes de escribir.
  const espera = entre(4, 18) * 1000;
  await sleep(Math.min(espera, Math.max(0, FIN - Date.now())));

  turno++;
  let res = await pedir(mensaje);
  // Reintento: un hipo de Meta (o del broker trabado) no debe romper el hilo.
  // El broker serializa los turnos: si el anterior quedo huerfano, este
  // reintento espera en cola, por eso la pausa es larga (60-120 s).
  let intentos = 0;
  while (res.code === 0 && intentos < 3 && !PARAR.ahora && Date.now() < FIN) {
    intentos++;
    fallos++;
    escribir(`[${ahora()}] (reintento ${intentos}/3: la llamada no volvió — ${String(res.crudo).slice(0, 90)})`);
    if (fallos >= 2) {
      escribir(`[${ahora()}] (aviso: ${fallos} fallos seguidos — el broker puede estar trabado; revisa /health y, si sigue igual, reinicia meta-api.service)`);
    }
    await sleep(entre(60, 120) * 1000);
    res = await pedir(mensaje);
  }
  const respuesta = textoRespuesta(res);

  const estado = res.code === 200 ? "ok" : `ERROR ${res.code}`;
  const lento = res.ms >= 120000;
  if (lento) lentos++;
  escribir("");
  escribir(`[turno ${String(turno).padStart(3, "0")}] ${ahora()} | ${HUMAN.toUpperCase()} → ${BOT} | ${estado} | ${(res.ms / 1000).toFixed(1)} s | tema: ${ultimoTema.titulo}`);
  if (lento) escribir("  (turno lento: el broker estaba ocupado o la respuesta fue muy larga — la conexión aguantó, no se cortó)");
  escribir("");
  escribir(`${HUMAN.toUpperCase()}:`);
  escribir(`  ${mensaje}`);
  escribir("");
  escribir(`${BOT}:`);
  if (respuesta) {
    for (const l of respuesta.split("\n")) escribir(`  ${l}`);
  } else {
    escribir(`  (sin respuesta — HTTP ${res.code}) ${res.crudo ? res.crudo.slice(0, 300) : ""}`);
  }
  if (res.json?.meta_conversation_id) {
    escribir(`  (hilo: ${res.json.meta_conversation_id})`);
  }

  if (res.code === 200) {
    ultimaRespuesta = respuesta;
    fallos = 0;
  } else {
    errores++;
    fallos++;
    if (res.code === 503 || res.code === 429) {
      const espera2 = Math.max(60, Number(res.retryAfter || 0) * 1000 + 30000);
      escribir(`  (pausa por límite de Meta: ${Math.round(espera2 / 1000)} s)`);
      await sleep(Math.min(espera2, Math.max(0, FIN - Date.now())));
      continue;
    }
    await sleep(entre(45, 120) * 1000);
  }

  // Pausa de lectura + pausa humana antes del siguiente turno.
  const lectura = Math.min(70, (respuesta.length || 120) * 0.09);
  await sleep((lectura + entre(10, 45)) * 1000);
}

// ── Cierre ──────────────────────────────────────────────────────────────────
const dur = ((Date.now() - INICIO) / 3600000).toFixed(2);
escribir("");
escribir("═".repeat(78));
escribir(`FIN DE LA CONVERSACIÓN — ${fechaLarga()}`);
escribir(`turnos enviados   : ${turno}`);
escribir(`errores           : ${errores}`);
escribir(`turnos lentos     : ${lentos} (>= 120 s, el broker estaba ocupado)`);
escribir(`preguntas con cita: ${citas}`);
escribir(`duración real     : ${dur} h`);
escribir(`log completo      : ${LOG}`);
escribir("═".repeat(78));
console.log(`[conversacion-larga] terminado: ${turno} turnos, ${errores} errores.`);
process.exit(0);
