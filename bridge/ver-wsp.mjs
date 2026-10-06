// ver-wsp.mjs — volcado de los ultimos mensajes del chat abierto en WhatsApp.
const CDP = process.env.WSP_CDP || "http://127.0.0.1:9233";
const l = await (await fetch(CDP + "/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no hay pestaña de WhatsApp"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const r = await call("Runtime.evaluate", { expression: `(() => {
  const m = document.querySelector('#main');
  if (!m) return JSON.stringify({ abierto: false });
  const titulo = (m.querySelector('header span[dir=auto]')?.textContent || '').trim();
  const filas = [...m.querySelectorAll('[role=row]')].filter(f => f.querySelector('[data-id]'));
  const msgs = filas.slice(-10).map(f => {
    const labels = [...f.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') || '');
    const esMio = labels.some(x => /^Tú:|^You:|Enviado|Leído|Entregado/i.test(x));
    const partes = (f.innerText || '').split('\\n').filter(Boolean);
    const texto = partes.filter(x => !/^\\d{1,2}:\\d{2}/.test(x))[0] || '';
    return (esMio ? '[YO] ' : '[ENTRANTE] ') + texto.replace(/\\s+/g,' ').slice(0,90);
  });
  return JSON.stringify({ abierto: true, titulo, msgs });
})()`, returnByValue: true });
console.log(r?.result?.value || "sin dato");
process.exit(0);
