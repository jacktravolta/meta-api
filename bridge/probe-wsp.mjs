// probe-wsp.mjs — lista los chats visibles en el sidebar de WhatsApp Web.
const CDP = "http://127.0.0.1:9333";
const lista = await (await fetch(CDP + "/json")).json();
const t = lista.find((x) => (x.url || "").includes("web.whatsapp.com"));
if (!t) { console.log("no hay pestaña de WhatsApp"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const call = (method, params) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
await call("Runtime.enable");
const ev = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; };

const estado = await ev(`(() => {
  return JSON.stringify({
    logueado: !!document.querySelector('#pane-side'),
    qr: !!document.querySelector('[data-ref], canvas[aria-label*="QR"], [aria-label*="QR"]'),
    main: !!document.querySelector('#main'),
    tituloMain: document.querySelector('#main header span[dir=auto]')?.textContent || null,
    chats: [...document.querySelectorAll('#pane-side [role=row], #pane-side [role=listitem]')].map(e => (e.innerText || '').split('\\n').filter(Boolean).slice(0, 2).join(' | ')).slice(0, 25)
  });
})()`);
console.log(estado);
process.exit(0);
