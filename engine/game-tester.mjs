// game-tester.mjs — prueba un juego web con CDP en un Chrome VISIBLE.
//
// El navegador es el del usuario (puerto 9298, perfil google-chrome-beta-debug)
// para que la supervision sea humana: la pestana queda abierta y se ve.
//
// No modifica el codigo del juego: solo instala observadores ANTES de que
// corra la pagina (Page.addScriptToEvaluateOnNewDocument) y despues le
// pregunta al DOM/canvas como va. Todo lo que hace es OBSERVAR y REPORTAR.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const UA_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ---------- servidor estatico del juego (http, no file://) ----------
export function serveDir(dir, port = 8123) {
	const mime = {
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
		".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav",
		".ogg": "audio/ogg", ".json": "application/json", ".ico": "image/x-icon",
	};
	const srv = http.createServer((req, res) => {
		const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
		const file = path.join(dir, rel);
		if (!file.startsWith(dir + path.sep) && file !== path.join(dir, "index.html")) {
			res.writeHead(403).end("no");
			return;
		}
		fs.readFile(file, (err, buf) => {
			if (err) { res.writeHead(404, { "content-type": "text/plain" }).end("no existe"); return; }
			res.writeHead(200, { "content-type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
			res.end(buf);
		});
	});
	return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${port}/index.html` })));
}

// ---------- cliente CDP minimo ----------
class CDP {
	constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
	static async attach(port, { nuevaUrl = null } = {}) {
		let page = null;
		// con nuevaUrl SIEMPRE se crea una pestana nueva: el navegador del
		// usuario tiene otras pestanas abiertas y no se tocan.
		if (nuevaUrl) {
			const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(nuevaUrl)}`, { method: "PUT" });
			page = await res.json();
		} else {
			const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			page = tabs.find((t) => t.type === "page");
			if (!page) {
				const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
				page = await res.json();
			}
		}
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
		const cdp = new CDP(ws);
		cdp.tabId = page.id;
		ws.onmessage = (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && cdp.pending.has(m.id)) {
				const { res, rej } = cdp.pending.get(m.id);
				cdp.pending.delete(m.id);
				if (m.error) rej(new Error(m.error.message)); else res(m.result);
			} else if (m.method) {
				for (const h of cdp.handlers.get(m.method) ?? []) h(m.params);
			}
		};
		return cdp;
	}
	on(method, fn) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(fn);
	}
	send(method, params = {}) {
		const id = ++this.id;
		return new Promise((res, rej) => {
			this.pending.set(id, { res, rej });
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 30_000);
		});
	}
	close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------- sonda que se instala ANTES de la pagina ----------
const PROBE = `
window.__probe = {
  errores: [], warnings: [], audio: 0, frames: 0, listo: false,
};
window.addEventListener('error', (e) => {
  window.__probe.errores.push('error: ' + (e.message || '') + (e.filename ? ' @' + e.filename + ':' + e.lineno : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__probe.errores.push('unhandledrejection: ' + ((r && r.message) || String(r)));
});
(() => {
  const _err = console.error.bind(console);
  console.error = (...a) => { window.__probe.errores.push('console.error: ' + a.map((x) => (x && x.message) || String(x)).join(' ')); _err(...a); };
  const _warn = console.warn.bind(console);
  console.warn = (...a) => { window.__probe.warnings.push('console.warn: ' + a.map(String).join(' ')); _warn(...a); };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const Wrapped = function (...args) { window.__probe.audio++; return new AC(...args); };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  }
  const OA = window.Audio;
  if (OA) {
    const W = function (...args) { window.__probe.audio++; return new OA(...args); };
    W.prototype = OA.prototype;
    window.Audio = W;
  }
  (function tick() { window.__probe.frames++; requestAnimationFrame(tick); })();
  window.__probeHash = () => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    try { return c.toDataURL('image/png').slice(-160); } catch (e) { return 'ERR:' + e.message; }
  };
  window.__probeKey = (key, code) => {
    for (const target of [window, document]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode: 0, which: 0, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode: 0, which: 0, bubbles: true, cancelable: true }));
    }
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Abre el juego en una pestana del Chrome visible y lo prueba.
 * Devuelve { errores, warnings,Checks, detalles } — NUNCA modifica el juego.
 */
export async function testGame({ dir, port = 8123, cdpPort = 9298, segundos = 4, mantenerPestana = true, cdp = null, url = null }) {
	let srv = null;
	if (!url) { const s = await serveDir(dir, port); srv = s.srv; url = s.url; }
	if (!cdp) cdp = await CDP.attach(cdpPort, { nuevaUrl: url });
	const errores = [];
	const warnings = [];
	const consola = [];

	cdp.on("Runtime.exceptionThrown", (p) => {
		const d = p.exceptionDetails ?? {};
		const txt = d.exception?.description ?? d.text ?? "desconocida";
		// las extensiones del chrome inyectan errores en la pagina: no son del juego
		if (/Receiving end does not exist|chrome-extension/i.test(txt)) return;
		errores.push(`excepcion: ${txt}`);
	});
	cdp.on("Runtime.consoleAPICalled", (p) => {
		const txt = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
		consola.push(`[${p.type}] ${txt}`);
		if (p.type === "error") errores.push(`consola: ${txt}`);
		if (p.type === "warning") warnings.push(`consola: ${txt}`);
	});
	cdp.on("Log.entryAdded", (p) => {
		const e = p.entry ?? {};
		// el 404 del favicon NO es un fallo del juego: ruido que haria
		// corregir a meta algo que esta bien
		if (/favicon\.ico/.test(e.url ?? "")) return;
		// errores de extensiones del chrome del usuario: no son del juego
		if (/Receiving end does not exist|chrome-extension/i.test(`${e.text} ${e.url ?? ""}`)) return;
		if (e.level === "error") errores.push(`log: ${e.text} ${e.url ?? ""}`);
		if (e.level === "warning") warnings.push(`log: ${e.text} ${e.url ?? ""}`);
	});

	await cdp.send("Runtime.enable");
	await cdp.send("Log.enable");
	await cdp.send("Page.enable");
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });

	await cdp.send("Page.navigate", { url });
	await sleep(1200);
	// la pagina puede redirigir o recargar: se espera a que el probe exista
	for (let i = 0; i < 20; i++) {
		const r = await cdp.send("Runtime.evaluate", { expression: "!!window.__probe", returnByValue: true });
		if (r.result?.value) break;
		await sleep(300);
	}

	// 0) arrancar el juego: muchos juegos esperan una tecla (Enter/Espacio)
	//    antes de empezar a dibujar. Sin esto se mediria una pantalla de inicio.
	for (const [k, c] of [["Enter", "Enter"], [" ", "Space"]]) {
		await cdp.send("Runtime.evaluate", { expression: `window.__probeKey(${JSON.stringify(k)}, ${JSON.stringify(c)})`, returnByValue: true });
		await sleep(200);
	}
	await sleep(700);

	// 1) el bucle de render sigue vivo?
	const f1 = await cdp.send("Runtime.evaluate", { expression: "window.__probe?.frames ?? 0", returnByValue: true });
	await sleep(700);
	const f2 = await cdp.send("Runtime.evaluate", { expression: "window.__probe?.frames ?? 0", returnByValue: true });

	// 2) el canvas cambia (el juego dibuja)?
	const h1 = await cdp.send("Runtime.evaluate", { expression: "window.__probeHash ? window.__probeHash() : null", returnByValue: true });
	await sleep(900);
	const h2 = await cdp.send("Runtime.evaluate", { expression: "window.__probeHash ? window.__probeHash() : null", returnByValue: true });

	// 3) el teclado no revienta nada
	for (const [k, c] of [["ArrowRight", "ArrowRight"], ["ArrowDown", "ArrowDown"], ["ArrowLeft", "ArrowLeft"], ["ArrowUp", "ArrowUp"], ["Enter", "Enter"], [" ", "Space"]]) {
		await cdp.send("Runtime.evaluate", { expression: `window.__probeKey(${JSON.stringify(k)}, ${JSON.stringify(c)})`, returnByValue: true });
		await sleep(250);
	}
	const h3 = await cdp.send("Runtime.evaluate", { expression: "window.__probeHash ? window.__probeHash() : null", returnByValue: true });

	// 4) estado final
	const estado = await cdp.send("Runtime.evaluate", {
		expression: `(() => {
			const p = window.__probe || {};
			return {
				errores: p.errores || [], warnings: p.warnings || [], audio: p.audio ?? 0,
				frames: p.frames ?? 0,
				canvas: document.querySelectorAll('canvas').length,
				titulo: document.title,
				texto: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').trim().slice(0, 300),
				scripts: document.querySelectorAll('script').length,
				estilos: document.querySelectorAll('style,link[rel=stylesheet]').length,
			};
		})()`, returnByValue: true,
	});
	const s = estado.result?.value ?? {};

	const checks = {
		"sin errores de runtime": errores.length === 0 && (s.errores ?? []).length === 0,
		"el canvas existe": (s.canvas ?? 0) > 0,
		"el bucle de animacion corre": (f2.result?.value ?? 0) > (f1.result?.value ?? 0),
		"el canvas se dibuja (pixels cambian)": !!h1.result?.value && !!h2.result?.value && h1.result.value !== h2.result.value,
		"el teclado responde (el dibujo cambia tras mover)": !!h3.result?.value && h3.result.value !== h2.result.value,
		"hay audio (sonidos)": (s.audio ?? 0) > 0,
	};

	const detalle = {
		url, cdpPort,
		frames: [f1.result?.value, f2.result?.value],
		hashes: { antes: String(h1.result?.value).slice(-40), durante: String(h2.result?.value).slice(-40), trasTeclas: String(h3.result?.value).slice(-40) },
		pagina: s, consola: consola.slice(-12),
	};

	// la pestana se deja ABIERTA: supervision humana
	if (!mantenerPestana) { cdp.close(); srv?.close(); }
	else {
		// el servidor sigue vivo para que la pagina no se caiga al recargar
		detalle.srv = srv;
		detalle.cdp = cdp;
	}
	return { errores: [...errores, ...(s.errores ?? [])], warnings: [...warnings, ...(s.warnings ?? [])], checks, detalle };
}

export { sleep };
