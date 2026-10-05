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
// Exported for the test suite: the policy is the security boundary, so its
// decisions on concrete commands are pinned by regression tests.
export function classify(command) {
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

// Capability probe, so the loop can refuse to start when the sandbox is not
// actually enforcing anything. Each dimension gets its own sub-probe so each
// one classifies the way its assertion needs:
//
//   * write  : the write attempt runs under the DEFAULT policy and must be
//              DENIED by the policy layer (writeBlocked). It is never
//              executed, so nothing can appear on the host. The previous
//              single-probe version passed allowWrite:true and leaked
//              .sandbox-probe into the workspace on every verified request.
//   * fs     : a read-classified command must execute and see the mounted
//              workspace (test -r is NOT whitelisted, so the probe uses ls).
//   * network : trusted static code, never model output. It still needs
//              allowWrite because curl and the >/dev/null redirect classify
//              as write; what it verifies is the allowNetwork DEFAULT: the
//              fetch must fail because of --network none, not because we
//              granted egress. hostHomeInvisible rides along on it for the
//              same reason: `hostname` is not on the read-only whitelist.
export async function selfCheck() {
  // (a) Write policy: denied:true means the policy layer refused the command
  // before any container existed. Anything else (the write running, or a
  // docker failure) means the sandbox is not enforcing the default policy.
  const writeProbe = await runSandboxed("echo probe > /workspace/.sandbox-probe");
  const writeBlocked = writeProbe.denied === true;

  // (b) Mount proof: a read-classified command under the default policy.
  const fsProbe = await runSandboxed("ls /workspace && echo FS_OK");
  const fsRead = fsProbe.ok && /FS_OK/.test(fsProbe.output || "");

  // (c) + (d) Network posture and host visibility: trusted static code.
  const netProbe = await runSandboxed(
    "curl -s -m 3 https://example.com >/dev/null 2>&1 && echo NET_LEAK || echo NET_BLOCKED; " +
    "id -u; hostname",
    { allowWrite: true },
  );
  const netOut = netProbe.output || "";
  const networkBlocked = /NET_BLOCKED/.test(netOut);
  // hostHomeInvisible: the last line is the container hostname, never the
  // host's. A shared network namespace would leak it.
  const hostHomeInvisible = !/\btest\b/.test(netOut.split("\n").slice(-1)[0] || "");

  return {
    ok: writeBlocked && fsRead && networkBlocked && hostHomeInvisible,
    writeBlocked,
    fsRead,
    networkBlocked,
    hostHomeInvisible,
    raw: [writeProbe.output, fsProbe.output, netOut].filter(Boolean).join("\n---\n").trim(),
  };
}