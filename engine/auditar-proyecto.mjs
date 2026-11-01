// auditar-proyecto.mjs — auditoria de un proyecto entregado por meta.
//
// No corrige NADA: solo ejecuta y reporta el error EXACTO (comando, archivo,
// salida) para que se le mande a meta.
//
//   node engine/auditar-proyecto.mjs <dir> [--json]
//
// Auditoria:
//   1) estructura SDD (README, specs/, design/, tasks/, src/, tests/)
//   2) sintaxis de cada archivo (py_compile / node --check)
//   3) suite de pruebas (pytest o unittest) — salida cruda
//   4) arranque de la app (run.sh / app.py) y smoke test HTTP
//   5) busca secretos y marcadores pendientes

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const REQUERIDOS = [
	{ path: "README.md", tipo: "archivo", porque: "punto de entrada del proyecto" },
	{ path: "specs", tipo: "dir", porque: "specs del SDD" },
	{ path: "design", tipo: "dir", porque: "diseno del SDD" },
	{ path: "tasks", tipo: "dir", porque: "plan de tareas del SDD" },
	{ path: "tests", tipo: "dir", porque: "pruebas automatizadas" },
];

const correr = async (cmd, args, cwd, timeout = 180_000) => {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: err.code ?? 1,
			stdout: err.stdout?.toString() ?? "",
			stderr: err.stderr?.toString() ?? String(err.message ?? err),
		};
	}
};

function listar(dir, base = dir, acc = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".") || e.name === "__pycache__" || e.name === "node_modules" || e.name === ".venv") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) listar(p, base, acc);
		else acc.push(path.relative(base, p));
	}
	return acc;
}

/** Auditoria completa. Devuelve { errores, avisos, estructura, detalle }. */
export async function auditar(dir) {
	const errores = [];
	const avisos = [];
	const detalle = { comandos: [], archivos: listar(dir) };

	// ---------- 1) estructura ----------
	const estructura = [];
	for (const req of REQUERIDOS) {
		const p = path.join(dir, req.path);
		const ok = req.tipo === "dir" ? fs.existsSync(p) && fs.statSync(p).isDirectory()
			: fs.existsSync(p) && fs.statSync(p).isFile();
		estructura.push({ ...req, ok });
		if (!ok) errores.push({
			archivo: req.path,
			comando: `ls ${req.path}`,
			salida: `no existe ${req.tipo} ${req.path} (${req.porque})`,
		});
	}
	detalle.estructura = estructura;

	// ---------- 2) sintaxis ----------
	const py = detalle.archivos.filter((f) => f.endsWith(".py"));
	const js = detalle.archivos.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
	for (const f of py) {
		const r = await correr("python3", ["-m", "py_compile", f], dir, 60_000);
		detalle.comandos.push({ cmd: `python3 -m py_compile ${f}`, code: r.code });
		if (r.code !== 0) errores.push({
			archivo: f,
			comando: `python3 -m py_compile ${f}`,
			salida: (r.stderr || r.stdout).trim().slice(0, 1500),
		});
	}
	for (const f of js) {
		const r = await correr("node", ["--check", f], dir, 60_000);
		detalle.comandos.push({ cmd: `node --check ${f}`, code: r.code });
		if (r.code !== 0) errores.push({
			archivo: f,
			comando: `node --check ${f}`,
			salida: (r.stderr || r.stdout).trim().slice(0, 1500),
		});
	}

	// ---------- 3) pruebas ----------
	const tienePytest = detalle.archivos.some((f) => /^tests?\/.*test_.*\.py$/.test(f) || /test_.*\.py$/.test(f));
	let rPruebas = null;
	if (tienePytest) {
		const r = await correr("python3", ["-m", "pytest", "-q", "--tb=short"], dir, 300_000);
		rPruebas = r;
		detalle.comandos.push({ cmd: "python3 -m pytest -q --tb=short", code: r.code });
		if (r.code !== 0) errores.push({
			archivo: "tests/",
			comando: "python3 -m pytest -q --tb=short",
			salida: ((r.stdout || "") + (r.stderr || "")).trim().slice(-3000),
		});
	} else {
		avisos.push("no se detectaron pruebas en python (tests/test_*.py)");
	}

	// ---------- 4) arranque ----------
	const hayRun = fs.existsSync(path.join(dir, "run.sh"));
	const appPy = ["app.py", "src/app.py", "src/main.py", "main.py"].find((f) => fs.existsSync(path.join(dir, f)));
	if (hayRun || appPy) {
		const cmd = hayRun ? `bash ${"run.sh"}` : `python3 ${appPy}`;
		const proc = exec(cmd, { cwd: dir, timeout: 25_000, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
		let salida = "";
		proc.stdout?.on("data", (d) => { salida += d.toString(); });
		proc.stderr?.on("data", (d) => { salida += d.toString(); });
		const puerto = await detectarPuerto(salida);
		let health = null;
		if (puerto) {
			health = await probarHealth(puerto);
		}
		try { proc.kill("SIGKILL"); } catch { /* ignore */ }
		if (/Traceback|Error|Exception|error:/i.test(salida) && !puerto) {
			errores.push({ archivo: hayRun ? "run.sh" : appPy, comando: cmd, salida: salida.trim().slice(-2500) });
		} else if (puerto && health && !health.ok) {
			errores.push({ archivo: hayRun ? "run.sh" : appPy, comando: `curl http://127.0.0.1:${puerto}/health`, salida: health.salida });
		} else if (!puerto) {
			avisos.push(`la app no dejo claro el puerto en su salida (arranque no verificable)`);
		}
		detalle.arranque = { cmd, puerto, health: health?.ok ?? null };
	} else {
		avisos.push("no hay run.sh ni app.py: no se pudo verificar el arranque");
	}

	// ---------- 5) secretos / pendientes ----------
	const patrones = [
		{ re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/gi, que: "posible secreto en texto plano" },
		{ re: /\b(TODO|FIXME|HACK|XXX)\b/g, que: "marcador pendiente" },
	];
	for (const f of detalle.archivos.filter((x) => /\.(py|js|mjs|md|txt|json|ya?ml|sh)$/.test(x))) {
		let txt = "";
		try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
		for (const p of patrones) {
			const m = txt.match(p.re);
			if (m) avisos.push(`${f}: ${p.que} (${m.length})`);
		}
	}

	return { errores, avisos, estructura, detalle, pruebas: rPruebas ? { code: rPruebas.code, salida: (rPruebas.stdout || "").trim().slice(-1200) } : null };
}

async function detectarPuerto(salida) {
	// puertos citados en la salida + los habituales
	const citados = [...new Set((String(salida).match(/\d{4,5}/g) ?? []).map(Number))]
		.filter((n) => n > 1023 && n < 65536);
	for (const n of citados.concat([8000, 8080, 5000, 3000])) {
		if (await puertoVivo(n)) return n;
	}
	return null;
}

function puertoVivo(puerto) {
	return new Promise((res) => {
		const s = net.connect({ port: puerto, host: "127.0.0.1" }, () => { s.destroy(); res(true); });
		s.on("error", () => res(false));
		s.setTimeout(700, () => { s.destroy(); res(false); });
	});
}

async function probarHealth(puerto) {
	try {
		const r = await fetch(`http://127.0.0.1:${puerto}/health`, { signal: AbortSignal.timeout(4000) });
		const t = await r.text();
		return { ok: r.ok, salida: `HTTP ${r.status}: ${t.slice(0, 300)}` };
	} catch (err) {
		return { ok: false, salida: `GET /health fallo: ${String(err?.message ?? err).slice(0, 200)}` };
	}
}
