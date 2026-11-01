// debug.mjs — que ve la pestaña al abrir meta.ai headless
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9299;
const PROFILE = mkdtempSync(join(tmpdir(), "metaai-capture-"));
const chrome = spawn("/usr/bin/google-chrome-beta", [
	"--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
	"--no-first-run", "--window-size=1280,900", "--enable-logging=stderr", "--v=0",
	"https://www.meta.ai/",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", (d) => {
	const s = String(d);
	if (/DevTools listening/.test(s)) console.error("LISTO");
});

const deadline = Date.now() + 20000;
let page = null;
while (Date.now() < deadline) {
	try {
		const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
		if (t?.length) { page = t.find((x) => x.type === "page"); break; }
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.error("sin pagina"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 1; const pending = new Map();
let reqCount = 0;
const urls = [];
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
	if (m.method === "Network.requestWillBeSent") {
		reqCount++;
		if (urls.length < 40) urls.push(m.params.request.url);
	}
};
const call = (method, params = {}) => new Promise((r) => {
	const id = seq++; pending.set(id, r);
	ws.send(JSON.stringify({ id, method, params }));
});
await call("Network.enable");
await call("Page.enable");
await call("Page.navigate", { url: "https://www.meta.ai/" });
await new Promise((r) => setTimeout(r, 12000));
const st = await call("Runtime.evaluate", { expression: "JSON.stringify({title: document.title, url: location.href, body: document.body.innerText.slice(0,400)})" , returnByValue: true });
console.log("ESTADO:", st?.result?.value);
await call("Page.captureScreenshot").then((s) => {
	if (s?.data) writeFileSync("/tmp/opencode/metaai-shot.png", Buffer.from(s.data, "base64"));
});
console.log(`requests totales: ${reqCount}`);
for (const u of urls) console.log("  ", u.slice(0, 140));
ws.close(); chrome.kill("SIGKILL"); process.exit(0);
