// Sandboxed command execution for agent tools.
//
// Everything a tool runs executes inside an ephemeral container: no network,
// read-only root, all capabilities dropped, no new privileges, capped memory,
// CPUs and PIDs, and a hard timeout. The workspace is mounted read-only unless
// writes were explicitly enabled, so a chat model cannot rewrite the host.
//
// This module exists because the agent loop feeds text produced by Meta AI into
// a shell. Without this boundary that is remote code execution with a public web
// UI as the attacker.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULTS = {
  image: process.env.META_SANDBOX_IMAGE || "meta-sandbox:1",
  workdir: process.env.META_SANDBOX_WORKDIR || "/home/test/test",
  memory: "256m",
  cpus: "1",
  pids: 100,
  timeoutMs: 30_000,
  maxOutputBytes: 8192,
  allowNetwork: false,
  allowWrite: false,
  shell: "/bin/sh",
};

// Classification is DENY BY DEFAULT. An earlier version decided from the leading
// token alone, so `echo ok > /workspace/f.txt` matched the read-only `echo` rule
// and the workspace stayed read-only even with allowWrite. Now anything that
// mutates is a write unless it is unambiguously a read.
const WRITE_MARKERS =
  /(>\s*\S|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\btruncate\b|\btee\b|\bdd\b|\bmount\b|\bsudo\b|\bsu\b|\bapt\b|\bapt-get\b|\bpip\s+install\b|\bnpm\s+i\b|\bgit\s+(add|commit|checkout|reset|push|merge|rebase|clean|init|apply|stash|tag)\b|\bsed\s+-i\b|\bcrontab\b)/;

const READ_ONLY = [
  /^\s*(ls|cat|head|tail|wc|grep|egrep|rg|find|file|stat|du|df|echo|pwd|date|whoami|id|which|realpath|basename|dirname|sort|uniq|cut|awk|tr|diff|less|seq|env|printenv|nl|md5sum|sha256sum)\b[^;&|]*$/,
  /^\s*git\s+(status|log|show|diff|branch|remote|ls-files|describe|rev-parse|blame|shortlog)\b[^;&|]*$/,
  /^\s*(node|python3?|bash|sh)\s+--version\s*$/,
];

// A pipe chain is read-only only if EVERY segment is. Splitting on the shell
// operators is what makes `ls | head` allowed while `ls | tee file` is not.
function classify(command) {
  if (WRITE_MARKERS.test(command)) return { write: true, why: "operador o comando mutante" };
  for (const segment of String(command).split(/[|;&]/)) {
    const s = segment.trim();
    if (!s) continue;
    if (!READ_ONLY.some((re) => re.test(s))) {
      return { write: true, why: `"${s}" no esta en la lista blanca de solo lectura` };
    }
  }
  return { write: false };
}

export async function runSandboxed(command, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const needsWrite = classify(command).write;
  if (needsWrite && !o.allowWrite) {
    return {
      ok: false, denied: true,
      output: `Comando denegado por la politica de escritura (${classify(command).why}): ${command}\n` +
              `Habilitalo con allowWrite solo si confias en esta sesion.`,
    };
  }

  // Two independent brakes on runaway commands. The inner `timeout` makes the
  // container kill its own process group, because killing the host-side docker
  // CLI does NOT stop the container: with only execFile's timeout, `sleep 30`
  // under a 5s budget kept running for the full 30s.
  //
  // The command is handed to a nested `sh -c` instead of being quoted inline:
  // `timeout 5 "cat f | head"` passes the whole string as ONE argument, so the
  // pipe is never interpreted.
  const name = `meta-sbx-${randomUUID().slice(0, 8)}`;
  const secs = Math.ceil(o.timeoutMs / 1000);
  const inner = `timeout ${secs} ${o.shell} -c ${JSON.stringify(command)}`;

  const dockerArgs = [
    "run", "--rm",
    "--name", name,
    "--network", o.allowNetwork ? "bridge" : "none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory", o.memory,
    "--cpus", o.cpus,
    "--pids-limit", String(o.pids),
    "-v", `${o.workdir}:/workspace${needsWrite && o.allowWrite ? "" : ":ro"}`,
    "-w", "/workspace",
    "-e", "HOME=/tmp",
    "--tmpfs", "/tmp:rw,size=32m",
    o.image,
    o.shell, "-c", inner,
  ];

  const started = Date.now();
  let hostTimer = null;
  return await new Promise((resolve) => {
    const child = execFile("docker", dockerArgs,
      { timeout: o.timeoutMs + 8000, maxBuffer: o.maxOutputBytes * 4 },
      (err, stdout, stderr) => {
        clearTimeout(hostTimer);
        const out = String(stdout || "") + (stderr ? `\n${stderr}` : "");
        const truncated = Buffer.byteLength(out) > o.maxOutputBytes;
        function exitCodeOf(e) {
          const c = e?.code;
          if (typeof c === "number") return c;
          const m = String(c ?? "").match(/exit (\d+)/);
          return m ? Number(m[1]) : (c === null ? 0 : 1);
        }
        resolve({
          ok: !err || err.code === 0,
          exitCode: err?.code ?? 0,
          output: truncated ? out.slice(0, o.maxOutputBytes) + "\n[salida truncada]" : out,
          truncated,
          ms: Date.now() - started,
          // GNU timeout exits 124; the host-side backstop kills the container with
          // SIGKILL, which surfaces as 137 (128+9). Both mean the sandbox cut the
          // command short. Checking stderr for the word "timeout" alone missed both.
          timedOut: [124, 137].includes(exitCodeOf(err)) || err?.killed === true ||
                    err?.signal === "SIGTERM" || /Terminated|timed out/i.test(String(stderr || "")),
        });
      });
    // Host-side backstop: if we are still here after the budget, kill the container
    // by name rather than only the CLI process.
    hostTimer = setTimeout(() => {
      try { execFile("docker", ["kill", name], () => {}); } catch {}
    }, o.timeoutMs);
  });
}

// Cheap capability probe, so the loop can refuse to start when the sandbox is
// not actually enforcing anything. Uses allowWrite on purpose: this is our own
// probe, never model output, and it needs to test that writes DO fail inside.
export async function selfCheck() {
  // Probe the DEFAULT policy: writes must be refused by the policy AND the mount
  // must be read-only. Probing with allowWrite would show a write succeeding and
  // wrongly report the sandbox as unprotected.
  const r = await runSandboxed(
    'test -r /workspace && echo FS_OK; ' +
    'curl -s -m 3 https://example.com >/dev/null 2>&1 && echo NET_LEAK || echo NET_BLOCKED; ' +
    'echo x > /workspace/.sandbox-probe 2>/dev/null && echo WRITE_LEAK || echo WRITE_BLOCKED; ' +
    'id -u; hostname',
    { timeoutMs: 25000, allowWrite: true });
  const out = r.output || "";
  return {
    ok: r.ok && /FS_OK/.test(out),
    fsRead: /FS_OK/.test(out),
    networkBlocked: /NET_BLOCKED/.test(out),
    // hostHomeInvisible: the last line is the container hostname, never "test".
    hostHomeInvisible: !/\btest\b/.test(out.split("\n").slice(-1)[0] || ""),
    raw: out.trim(),
  };
}