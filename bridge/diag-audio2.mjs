const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map(); const evs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value); p.delete(m.id); return; } if (m.method && /Network|Media/.test(m.method)) evs.push(m.method); };
const call = (m, pa) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: pa })); setTimeout(()=>r(undefined),15000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
// buscar una nota de voz y clickear play
await call("Network.enable", {});
console.log("boton play:", await q(`(() => { const b=[...document.querySelectorAll('#main [aria-label*="eproducir"]')][0]; if(!b) return 'no hay'; b.click(); return 'clickeado'; })()`));
await sleep(5000);
console.log("eventos de red vistos:", evs.length, [...new Set(evs)].slice(0,6));
console.log("audios tras play:", await q(`document.querySelectorAll('#main audio').length`));
console.log("elementos src blob:", await q(`document.querySelectorAll('#main [src^="blob:"]').length`));
console.log("tag del reproductor:", await q(`(() => { const b=document.querySelector('#main [aria-label*="eproducir"]'); if(!b) return null; let n=b; for(let i=0;i<8&&n;i++){ n=n.parentElement; if(n && n.querySelectorAll('audio, [src^="blob:"]').length) return n.outerHTML.slice(0,300); } return 'sin audio en ancestros'; })()`));
process.exit(0);
