const l = await (await fetch("http://127.0.0.1:9233/json")).json();
for (const t of l.filter(x => x.type === "page")) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let i=1; const p=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m.result?.result?.value);p.delete(m.id);}};
  const call=(m,pa)=>new Promise(r=>{const id=i++;p.set(id,r);ws.send(JSON.stringify({id,method:m,params:pa}));setTimeout(()=>r(undefined),8000);});
  await new Promise(r=>{if(ws.readyState===1)return r();ws.onopen=()=>r();setTimeout(r,4000);});
  const q = async (e) => await call("Runtime.evaluate", { expression: e, returnByValue: true });
  console.log("--- tab " + t.id.slice(0,8));
  console.log("  url:", (t.url||"").slice(0,70));
  console.log("  title:", await q("document.title"));
  console.log("  body:", (await q("(document.body.innerText||'').replace(/\\n+/g,' ').slice(0,80)") || ""));
  ws.close();
}
process.exit(0);
