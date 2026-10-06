import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const l = await (await fetch("http://127.0.0.1:9233/json")).json();
const t = l.find((x) => (x.url || "").includes("web.whatsapp.com"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let i = 1; const p = new Map(); const EV = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) { p.get(m.id)(m.result?.result?.value ?? m.result?.result); p.delete(m.id); return; }
  if (m.method === "Network.responseReceived") EV.push(m.params);
};
const call = (m, pa, aw) => new Promise((r) => { const id = i++; p.set(id, r); ws.send(JSON.stringify({ id, method: m, params: { ...pa, ...(aw ? { awaitPromise: true } : {}) } })); setTimeout(()=>r(undefined),30000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => { if (ws.readyState === 1) return r(); ws.onopen = () => r(); setTimeout(r, 5000); });
const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });

// encontrar una nota de voz
const id = await q(`(() => { const b=[...document.querySelectorAll('#main [aria-label*="eproducir"]')][0]; if(!b) return null; const row=b.closest('[role=row]'); const c=row?.querySelector('[data-id]'); return c ? c.getAttribute('data-id') : null; })()`);
console.log("data-id de la nota de voz:", id);
if (!id) process.exit(1);
await call("Network.enable", {});
EV.length = 0;
await q(`(() => { const f=[...document.querySelectorAll('[role=row]')].find(r=>r.querySelector('[data-id="${id}"]')); const b=[...f.querySelectorAll('[aria-label*="eproducir"]')][0]; if(b){ b.click(); return true; } return false; })()`);
await sleep(6000);
const con = EV.find(e => /audio/i.test(e.response?.mimeType || ""));
console.log("evento de audio:", con ? con.response.url.slice(0,60) + " [" + con.response.mimeType + "]" : "NO");
if (!con) process.exit(1);
const b64 = await call("Runtime.evaluate", { expression: `(async () => { try { const r = await fetch(${JSON.stringify(con.response.url)}); const b = await r.arrayBuffer(); const by = new Uint8Array(b); let s=''; for (let i=0;i<by.length;i++) s+=String.fromCharCode(by[i]); return btoa(s); } catch(e) { return null; } })()`, returnByValue: true }, true);
if (!b64) { console.log("no se pudo bajar el blob"); process.exit(1); }
const ruta = "/tmp/nota-voz-test.ogg";
writeFileSync(ruta, Buffer.from(b64, "base64"));
console.log("audio guardado:", ruta, "(", Math.round(b64.length * 0.75), "bytes )");
const tr = spawnSync("/home/test/Documentos/Proyectos/opencode-gateway/venv/bin/python", ["/home/test/test/meta-api/bridge/transcribir.py", ruta], { encoding: "utf8", timeout: 240000 });
console.log("TRANSCRIPCION:", (tr.stdout || "").trim().slice(0, 300) || "(vacia)");
process.exit(0);
