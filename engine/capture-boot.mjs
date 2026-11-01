// capture-boot.mjs — boot de meta.ai logueado: guarda los POST api/graphql con body
// para encontrar la entrega del token del gateway (ecto1) sin enviar ningun mensaje.
import { writeFileSync } from "node:fs";

const PORT = 9298;
const OUT = "/tmp/opencode/capture-boot.json";
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = tabs.find((t) => t.type === "page" && /^https?:/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 1;
const pending = new Map();
const captured = [];
const inflight = new Map();
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	const p = m.params ?? {};
	if (m.method === "Network.requestWillBeSent") {
		const u = p.request?.url ?? "";
		if (/api\/graphql/.test(u)) {
			inflight.set(p.requestId, { url: u, headers: p.request.headers, postData: p.request.postData?.slice(0, 3000) ?? null });
		}
	}
	if (m.method === "Network.loadingFinished" && inflight.has(p.requestId)) {
		inflight.get(p.requestId)._done = true;
	}
	if (m.method === "Network.responseReceived" && inflight.has(p.requestId)) {
		const rq = inflight.get(p.requestId);
		rq._rid = p.requestId;
		rq.status = p.response.status;
	}
};
const call = (method, params = {}) => new Promise((r) => { const id = seq++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await call("Network.enable");
await call("Page.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
// 25s de boot
for (let i = 0; i < 25; ++i) {
	await new Promise((r) => setTimeout(r, 1000));
	for (const [id, rq] of inflight) {
		if (rq._rid && rq._done && !rq._fetched) {
			rq._fetched = true;
			try {
				const b = await call("Network.getResponseBody", { requestId: id });
				rq.body = (b.body ?? "").slice(0, 20000);
				captured.push(rq);
			} catch {}
		}
	}
}
ws.close();
writeFileSync(OUT, JSON.stringify(captured, null, 1));
console.error(`capturadas ${captured.length} con body`);
// deja el archivo listo para el grep
process.exit(0);
