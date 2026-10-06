// es-donbot.mjs — deteccion robusta de la invocacion a Don Bot.
// Actúa si el texto dice "Don Bot" en cualquier forma: mayus/minus, junto o
// separado, con o sin corchetes, con guion o tilde.
//   true:  "Don Bot", "donbot", "DON BOT", "don  bot", "[DON BOT]", "Don-Bot", "dón bot"
export const DON_BOT_RX = /\[?\s*d[oó]n[\s-]*b[oó]t\s*\]?/i;
export const esDonBot = (t) => DON_BOT_RX.test(String(t || ""));
export const quitarTag = (t) => String(t || "").replace(DON_BOT_RX, "").replace(/\s+/g, " ").trim();

if (import.meta.url === `file://${process.argv[1]}`) {
  const pruebas = ["Don Bot", "donbot", "DON BOT", "don  bot", "[DON BOT]", "[don bot]", "Don-Bot", "dón bot", "hola que tal", "no te metas"];
  for (const p of pruebas) console.log((esDonBot(p) ? "SI  " : "no  ") + JSON.stringify(p));
}
