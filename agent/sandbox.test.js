// Pins for the sandbox policy probe (selfCheck): each sub-probe command must
// classify the way its assertion needs. The write probe MUST classify as write —
// that is what makes the default policy refuse it before any container exists,
// so nothing can ever be written to the host. These command strings mirror
// selfCheck on purpose: if a probe is rephrased into something the policy would
// let through, this suite must fail.
//
// The same file pins the read-only classifier itself: deny-by-default means
// the whitelist entries are load-bearing, and every pipe segment and
// indirection shape is a regression hazard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

// ---- execFile spy seam -------------------------------------------------------
// `sandbox.js` imports `execFile` as a named ESM import, and Node snapshots a
// builtin's exports when its ESM facade is first created: neither patching the
// module namespace (`mock.method`/assignment) nor mutating the CJS exports
// after that import can reach it. Wrapping the CJS export BEFORE sandbox.js is
// first imported does, so the module is imported dynamically below, after the
// wrap. The wrapper records every spawn and calls through, so real executions
// are unaffected; the positive-control test fails if this seam ever stops
// intercepting. Design's Testing Strategy: "an injected execFile seam or a
// stubbed module".
//
// The wrapper delegates to `execFileImpl`, so a test may temporarily swap in a
// FAKE implementation to pin argv/timeout/result wiring without spawning: the
// spy still records every call, and each test restores the real function in a
// `finally` so no fake leaks into a later test.
const childProcess = createRequire(import.meta.url)("node:child_process");
const realExecFile = childProcess.execFile;
const execFileCalls = [];
let execFileImpl = realExecFile;
childProcess.execFile = (...args) => {
  execFileCalls.push(args);
  return execFileImpl(...args);
};

const { classify, selfCheck, runSandboxed, resolveBackend, buildBwrapArgv, buildSystemdArgv } =
  await import("./sandbox.js");

test("selfCheck write probe classifies as write, so the default policy denies it", () => {
  assert.equal(classify("echo probe > /workspace/.sandbox-probe").write, true);
});

test("selfCheck fs probe classifies as read, so it executes and proves the mount", () => {
  // `test -r /workspace` is NOT on the read-only whitelist, so the fs probe
  // must use whitelisted reads only.
  assert.equal(classify("ls /workspace && echo FS_OK").write, false);
});

test("selfCheck network probe classifies as write, so it runs as trusted static code", () => {
  // curl and the >/dev/null redirect are write-classified. That is expected:
  // the probe is our own code, never model output, and it verifies the
  // allowNetwork DEFAULT, not the write policy (the write probe does that).
  assert.equal(classify(
    "curl -s -m 3 https://example.com >/dev/null 2>&1 && echo NET_LEAK || echo NET_BLOCKED; " +
    "id -u; hostname",
  ).write, true);
});

// ---- Indirection hardening -------------------------------------------------
// The read-only whitelist is textual, so anything that turns a whitelisted
// command into an executor of OTHER text is a write. These pins keep the
// escape closed: $(...), backticks, find -exec/-delete, xargs, awk/sed system().

test("command substitution classifies as write", () => {
  assert.equal(classify("cat $(echo x)").write, true);
  assert.equal(classify("cat $(( 1 + 1 ))").write, true);
  assert.equal(classify("echo `id`").write, true);
});

test("find -exec and -delete classify as write", () => {
  assert.equal(classify("find . -name x -delete").write, true);
  assert.equal(classify("find . -type f -exec cat {} ;").write, true);
  assert.equal(classify("find . -name x -execdir rm {} +").write, true);
});

test("xargs classifies as write", () => {
  assert.equal(classify("cat list | xargs cat").write, true);
});

test("awk/sed system(...) classifies as write", () => {
  assert.equal(classify("awk 'system(\"ls\")'").write, true);
  assert.equal(classify("sed 's/x/y/system(/'").write, true);
});

test("plain reads still classify as read after the hardening", () => {
  assert.equal(classify("find . -type f -name '*.mjs'").write, false);
  assert.equal(classify("awk '{print $1}'").write, false);
  assert.equal(classify("ls /workspace && echo FS_OK").write, false);
});

// ---- Read-only whitelist matrix ---------------------------------------------

test("unambiguous reads classify as read", () => {
  for (const cmd of ["ls -la", "cat server.mjs", "grep -n async server.mjs",
                     "git log", "git diff", "head -5 f", "wc -l f"]) {
    assert.equal(classify(cmd).write, false, cmd);
  }
});

test("mutations classify as write", () => {
  for (const cmd of ["rm -rf x", "echo x > f", "sed -i s/a/b/ f", "git commit -m x",
                     "chmod +x f", "cp a b", "touch f", "mkdir d", "mv a b", "tee f"]) {
    assert.equal(classify(cmd).write, true, cmd);
  }
});

test("every segment of a pipe must be read-only", () => {
  assert.equal(classify("ls | grep x").write, false);
  assert.equal(classify("cat f | sh").write, true);       // `sh` is not a whitelisted read
  assert.equal(classify("ls | tee f").write, true);       // one mutating segment poisons the chain
});

// ---- Backend resolution (fail-closed selection) -------------------------------
// The spec's fail-closed contract: only `bwrap` and `docker` are valid, an
// unset/empty variable defaults to `bwrap`, and any other value returns an
// error naming the rejected value and the accepted set instead of silently
// falling back to a backend the operator never chose.

test("resolveBackend defaults to bwrap when META_SANDBOX_BACKEND is unset", () => {
  delete process.env.META_SANDBOX_BACKEND;
  assert.deepEqual(resolveBackend(), { backend: "bwrap" });
});

test("resolveBackend defaults to bwrap when META_SANDBOX_BACKEND is empty", () => {
  assert.deepEqual(resolveBackend(""), { backend: "bwrap" });
});

test("resolveBackend accepts docker", () => {
  assert.deepEqual(resolveBackend("docker"), { backend: "docker" });
});

test("resolveBackend accepts bwrap", () => {
  assert.deepEqual(resolveBackend("bwrap"), { backend: "bwrap" });
});

test("resolveBackend rejects an unknown backend with a fail-closed error", () => {
  const r = resolveBackend("podman");
  assert.equal(r.backend, undefined, "an invalid value must not resolve a backend");
  assert.ok(r.error, "an invalid value must return { error }");
  assert.match(String(r.error), /podman/, "error must name the rejected value");
  assert.match(String(r.error), /bwrap/, "error must name the accepted set");
  assert.match(String(r.error), /docker/, "error must name the accepted set");
});

// ---- Fail-closed dispatch (no process on refusal) -----------------------------
// The spy must prove that neither a policy-denied write nor an invalid
// backend ever reaches execFile: returning an error object is not enough if a
// process still started on the side.

test("runSandboxed with an invalid backend returns an error and starts no process", async () => {
  const saved = process.env.META_SANDBOX_BACKEND;
  process.env.META_SANDBOX_BACKEND = "podman";
  try {
    const before = execFileCalls.length;
    const r = await runSandboxed("ls /workspace");
    assert.equal(r.ok, false);
    assert.ok(r.error, "expected an error result for an invalid backend");
    assert.match(String(r.error), /podman/, "error must name the rejected value");
    assert.match(String(r.error), /bwrap/, "error must name the accepted set");
    assert.match(String(r.error), /docker/, "error must name the accepted set");
    assert.equal(execFileCalls.length, before, "no process may be started");
  } finally {
    if (saved === undefined) delete process.env.META_SANDBOX_BACKEND;
    else process.env.META_SANDBOX_BACKEND = saved;
  }
});

test("a policy-denied write returns denied:true and starts no process", async () => {
  const before = execFileCalls.length;
  const r = await runSandboxed("touch /workspace/pwned");
  assert.equal(r.denied, true);
  assert.equal(execFileCalls.length, before, "no process may be started");
});

test("the spy seam intercepts sandbox spawns (positive control)", async () => {
  // Without this, the two tests above would pass vacuously if the seam broke:
  // a spy that never fires always sees zero calls.
  // Phase 3 landed the bwrap dispatch, so the default arm is now `bwrap`; this
  // control pins the docker arm explicitly to keep proving the seam sees a
  // real spawn. The bwrap arm gets its own (fake-backed) pin in phase 3 below.
  const saved = process.env.META_SANDBOX_BACKEND;
  process.env.META_SANDBOX_BACKEND = "docker";
  try {
    const before = execFileCalls.length;
    await runSandboxed("ls /workspace");
    assert.ok(execFileCalls.length > before, "the execFile spy must observe a real run");
    assert.equal(execFileCalls[before][0], "docker", "the recorded spawn must be the sandbox");
  } finally {
    if (saved === undefined) delete process.env.META_SANDBOX_BACKEND;
    else process.env.META_SANDBOX_BACKEND = saved;
  }
});

// ---- End-to-end selfCheck (docker) -------------------------------------------

async function dockerReachable() {
  try {
    await promisify(realExecFile)("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    return true;
  } catch { return false; }
}

test("selfCheck enforces the whole default posture", async (t) => {
  if (!(await dockerReachable())) return t.skip("docker no disponible");
  // selfCheck only becomes backend-aware in phase 4; until then its probes
  // dispatch through the active backend, and the default is bwrap since the
  // phase-3 dispatch landed. Pin `docker` so this docker-posture e2e keeps
  // exercising docker (and stays valid after phase 4 delegates by backend).
  const saved = process.env.META_SANDBOX_BACKEND;
  process.env.META_SANDBOX_BACKEND = "docker";
  try {
    const r = await selfCheck();
    assert.equal(r.writeBlocked, true);       // the write attempt was refused by policy
    assert.equal(r.fsRead, true);             // the workspace mounted and is readable
    assert.equal(r.networkBlocked, true);     // --network none: the fetch cannot leave
    assert.equal(r.hostHomeInvisible, true);  // container hostname, never the host's
    assert.equal(r.ok, true);
    // The denied write probe never executed, so the host workspace stays clean.
    const defaultWorkdir = process.env.META_SANDBOX_WORKDIR || "/home/test/test";
    assert.equal(existsSync(defaultWorkdir + "/.sandbox-probe"), false);
  } finally {
    if (saved === undefined) delete process.env.META_SANDBOX_BACKEND;
    else process.env.META_SANDBOX_BACKEND = saved;
  }
});

// ---- Pure argv builders: bwrap jail ------------------------------------------
// Threat matrix, "Command text -> argv": this builder is the new subprocess
// boundary, so the four adversarial cases are pinned BEFORE buildBwrapArgv
// exists. The builder must treat model-authored text as data and host paths as
// an allowlist; if either property regresses, these go red. Everything here is
// a pure-function assertion: no Docker, no bwrap, no systemd spawn.
//
// Explicit opts keep the assertions independent of the host: the workdir and
// sandbox root live under /home/u, never under the real os.homedir().

const baseOpts = {
  workdir: "/home/u/project",
  bwrapRoot: "/home/u/sandbox",
  timeoutMs: 5_000,
  allowNetwork: false,
  allowWrite: false,
};

// The workspace is the only gated host path: locate its bind and report which
// flag (ro/rw) and source the builder chose.
function workspaceBind(argv) {
  const i = argv.findIndex((el, idx) =>
    (el === "--bind" || el === "--ro-bind") && argv[idx + 2] === "/workspace");
  assert.notEqual(i, -1, "the workspace must be bound at /workspace");
  return { flag: argv[i], src: argv[i + 1] };
}

test("threat: default argv binds /workspace read-only, never the host home or host root", () => {
  const argv = buildBwrapArgv("ls /workspace", baseOpts, false);
  const ws = workspaceBind(argv);
  assert.equal(ws.flag, "--ro-bind", "the default workspace bind must be read-only");
  assert.equal(ws.src, baseOpts.workdir);
  const home = os.homedir();
  for (let i = 0; i < argv.length - 1; i++) {
    if (["--bind", "--ro-bind", "--ro-bind-try"].includes(argv[i])) {
      assert.notEqual(argv[i + 1], "/", "the full host root must never be bound");
      assert.notEqual(argv[i + 1], home, "the host home must never be bound");
    }
  }
});

test("threat: allowNetwork alone never makes the workspace writable", () => {
  for (const needsWrite of [false, true]) {
    const argv = buildBwrapArgv("ls /workspace",
      { ...baseOpts, allowNetwork: true }, needsWrite);
    assert.equal(workspaceBind(argv).flag, "--ro-bind",
      `needsWrite=${needsWrite}: allowNetwork must not grant workspace writes`);
  }
  // Even with allowWrite acked, a read-classified command keeps a ro workspace.
  const readRun = buildBwrapArgv("ls /workspace",
    { ...baseOpts, allowNetwork: true, allowWrite: true }, false);
  assert.equal(workspaceBind(readRun).flag, "--ro-bind");
});

test("threat: allowWrite alone never re-adds --unshare-net or disables --unshare-all", () => {
  const argv = buildBwrapArgv("touch /workspace/f",
    { ...baseOpts, allowWrite: true }, true);
  assert.ok(argv.includes("--unshare-all"),
    "--unshare-all must survive an enabled write");
  assert.ok(!argv.includes("--unshare-net"),
    "--unshare-net must never appear: isolation is not write-gated");
  // allowWrite does flip the workspace bind, and ONLY the workspace bind.
  assert.equal(workspaceBind(argv).flag, "--bind");
});

test("threat: shell metacharacters stay one JSON-quoted argv element, never flags", () => {
  const cmd = 'echo "a"; $(id); `whoami`; rm -rf /';
  const argv = buildBwrapArgv(cmd, { ...baseOpts, allowWrite: true }, true);
  const sep = argv.lastIndexOf("--");
  assert.notEqual(sep, -1, "the flag list must end with --");
  const flags = argv.slice(0, sep);
  const tail = argv.slice(sep + 1);
  for (const el of flags) {
    for (const bad of [";", "$(", "`", '"', "whoami"]) {
      assert.ok(!el.includes(bad),
        `flag ${JSON.stringify(el)} must not carry command text (${bad})`);
    }
  }
  // The whole command survives as ONE element: <shell> -c <JSON.stringify(cmd)>.
  assert.equal(tail.length, 3);
  assert.equal(tail[1], "-c");
  assert.equal(tail[2], `timeout 5 /bin/sh -c ${JSON.stringify(cmd)}`);
  assert.equal(argv.filter((el) => el.includes("$(id)")).length, 1,
    "the command must appear in exactly one argv element");
});

test("bwrap argv pins the minimal allowlisted bind matrix and jail env", () => {
  const argv = buildBwrapArgv("ls /workspace", baseOpts, false);
  const has = (...xs) => argv.some((_, i) => xs.every((x, j) => argv[i + j] === x));
  assert.ok(has("--ro-bind", "/usr", "/usr"));
  assert.ok(has("--symlink", "usr/bin", "/bin"));
  assert.ok(has("--symlink", "usr/lib", "/lib"));
  assert.ok(has("--symlink", "usr/lib64", "/lib64"));
  assert.ok(has("--symlink", "usr/sbin", "/sbin"));
  assert.ok(has("--proc", "/proc"));
  assert.ok(has("--dev", "/dev"));
  assert.ok(has("--tmpfs", "/tmp"));
  assert.ok(has("--bind", baseOpts.bwrapRoot, "/sandbox"));
  assert.ok(argv.includes("--die-with-parent"));
  assert.ok(has("--chdir", "/workspace"));
  assert.ok(has("--setenv", "HOME", "/sandbox/home"));
  assert.ok(has("--setenv", "TMPDIR", "/tmp"));
  const pathIdx = argv.findIndex((el, i) => el === "--setenv" && argv[i + 1] === "PATH");
  assert.notEqual(pathIdx, -1, "PATH must be set");
  assert.ok(argv[pathIdx + 2].startsWith("/sandbox/bin"),
    "PATH must start with /sandbox/bin so user-prefix installs resolve");
  // Minimal /etc: exactly the allowlist, nothing else, all via --ro-bind-try.
  const etc = [];
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === "--ro-bind-try") etc.push(argv[i + 1]);
  }
  assert.deepEqual(etc, [
    "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts",
    "/etc/ld.so.cache", "/etc/ssl", "/etc/ca-certificates.conf", "/etc/localtime",
  ]);
});

test("bwrap argv isolates the network by default and re-exposes it only on opt-in", () => {
  const off = buildBwrapArgv("ls /workspace", baseOpts, false);
  assert.ok(off.includes("--unshare-all"), "the default must unshare every namespace");
  assert.ok(!off.includes("--unshare-net"));
  assert.ok(!off.some((el) => el.includes("resolv.conf")),
    "the resolver must not be bound without allowNetwork");
  assert.ok(!off.some((el) => el.includes("/run/systemd/resolve")));

  const on = buildBwrapArgv("ls /workspace", { ...baseOpts, allowNetwork: true }, false);
  assert.ok(!on.includes("--unshare-all"),
    "the opt-in replaces --unshare-all with the explicit namespace set");
  for (const f of ["--unshare-user", "--unshare-ipc", "--unshare-pid",
                   "--unshare-uts", "--unshare-cgroup"]) {
    assert.ok(on.includes(f), `${f} must stay isolated on an opt-in run`);
  }
  assert.ok(!on.includes("--unshare-net"),
    "opt-in works by NOT unsharing the net namespace, never by a flag");
  assert.ok(on.includes("/etc/resolv.conf"), "resolver bound only on opt-in");
  assert.ok(on.includes("/run/systemd/resolve"), "resolver dir bound alongside");
});

test("bwrap argv follows the design's build-time sequence exactly", () => {
  assert.deepEqual(buildBwrapArgv("ls /workspace", baseOpts, false), [
    "bwrap",
    "--die-with-parent",
    "--unshare-all",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates.conf", "/etc/ca-certificates.conf",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", "/home/u/sandbox", "/sandbox",
    "--ro-bind", "/home/u/project", "/workspace",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/sandbox/home",
    "--setenv", "PATH", "/sandbox/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TMPDIR", "/tmp",
    "--", "/bin/sh", "-c", 'timeout 5 /bin/sh -c "ls /workspace"',
  ]);
});

// ---- Pure argv builders: systemd resource envelope ---------------------------
// bwrap has no cgroup support, so the memory/CPU/PID caps live in the
// systemd-run wrapper. Without this envelope the jail would run unlimited,
// which the spec forbids. The defaults come in Docker syntax ("256m", cpus
// "1") and must be normalized to systemd syntax ("256M", "100%"), and the
// `--` separator must keep the bwrap argv verbatim behind it.

test("buildSystemdArgv wraps the bwrap argv in the default resource envelope", () => {
  const bwrapArgv = ["bwrap", "--die-with-parent", "--unshare-all"];
  const argv = buildSystemdArgv(bwrapArgv, baseOpts, "meta-sbx-0badc0de");
  // Flags only: execFile("systemd-run", argv) supplies the program name as
  // argv[0], so a leading "systemd-run" here would double it and the child
  // would swallow the unit/scope options as its command operand.
  assert.deepEqual(argv, [
    "--user", "--scope", "-q",
    "--unit", "meta-sbx-0badc0de",
    "-p", "MemoryMax=256M",
    "-p", "CPUQuota=100%",
    "-p", "TasksMax=100",
    "--",
    ...bwrapArgv,
  ]);
});

test("buildSystemdArgv normalizes memory and cpus to systemd syntax", () => {
  const bwrapArgv = ["bwrap"];
  const argv = buildSystemdArgv(bwrapArgv,
    { ...baseOpts, memory: "256m", cpus: "1" }, "meta-sbx-1");
  assert.ok(argv.includes("MemoryMax=256M"), "256m must normalize to 256M");
  assert.ok(argv.includes("CPUQuota=100%"), "cpus 1 must normalize to 100%");
  const argv2 = buildSystemdArgv(bwrapArgv,
    { ...baseOpts, memory: "512m", cpus: "2", pids: 50 }, "meta-sbx-1");
  assert.ok(argv2.includes("MemoryMax=512M"), "the rule must not be hardcoded");
  assert.ok(argv2.includes("CPUQuota=200%"), "cpus must scale to a percentage");
  assert.ok(argv2.includes("TasksMax=50"), "pids must pass through as TasksMax");
});

test("buildSystemdArgv keeps the bwrap argv verbatim behind the -- separator", () => {
  const bwrapArgv = ["bwrap", "--ro-bind", "/usr", "/usr", "--", "/bin/sh"];
  const argv = buildSystemdArgv(bwrapArgv, baseOpts, "meta-sbx-1");
  const sep = argv.indexOf("--");
  assert.equal(sep, argv.length - bwrapArgv.length - 1,
    "-- must sit immediately before the bwrap argv");
  assert.deepEqual(argv.slice(sep + 1), bwrapArgv);
  assert.equal(argv[0], "--user",
    "the builder returns flags only; execFile prepends the program name");
});
