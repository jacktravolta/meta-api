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
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync,
         writeFileSync } from "node:fs";
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

// ---- suite sandbox root -------------------------------------------------------
// sandbox.js snapshots META_BWRAP_ROOT into DEFAULTS when first imported, and
// phase 5 makes every bwrap run CREATE the root layout before binding it.
// Without this override the real-path tests below would create the host's
// ~/sandbox — the suite must never create, write or delete it. Point the
// default at a temp root BEFORE the import (per-test `bwrapRoot` opts still
// win), and restore the env plus remove the temp tree in `after`.
const savedBwrapRoot = process.env.META_BWRAP_ROOT;
const suiteBwrapRoot = mkdtempSync(path.join(os.tmpdir(), "sbx-suite-root-"));
process.env.META_BWRAP_ROOT = suiteBwrapRoot;

const { classify, selfCheck, runSandboxed, resolveBackend, buildBwrapArgv, buildSystemdArgv } =
  await import("./sandbox.js");

after(() => {
  rmSync(suiteBwrapRoot, { recursive: true, force: true });
  if (savedBwrapRoot === undefined) delete process.env.META_BWRAP_ROOT;
  else process.env.META_BWRAP_ROOT = savedBwrapRoot;
});

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
  // selfCheck delegates by backend since phase 4 and the default is `bwrap`,
  // so pin `docker` to keep this docker-posture e2e exercising the docker arm
  // (task 4.1: the docker probes themselves are behaviorally unchanged).
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

// ---- bwrap execution: envelope, double brake, fail-closed (phase 3) ------------
// Tasks 3.1-3.5. Two layers, matching design's Testing Strategy: fake-backed
// unit pins assert the systemd delegation, the backstop wiring, the result
// contract and the refusal WITHOUT spawning anything (host-independent), and
// real-path tests exercise the actual jail, `t.skip`-ing with the captured
// failure line when this host cannot provision it (the design's "must skip,
// not fail" rule — same pattern as the docker-daemon skip above).
//
// Session stubs: a usable systemd user session is observable spawn-free as a
// bus socket file, so a temp dir with a `bus` entry stands in for one, and
// deleting both session variables stands in for its absence. Every stub and
// fake is restored in `finally` so nothing leaks into a later test.

function stubUserSession() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sbx-session-"));
  writeFileSync(path.join(dir, "bus"), "");
  const savedXdg = process.env.XDG_RUNTIME_DIR;
  const savedDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.XDG_RUNTIME_DIR = dir;
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(dir, "bus")}`;
  return () => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
    if (savedDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = savedDbus;
    rmSync(dir, { recursive: true, force: true });
  };
}

function stubNoUserSession() {
  const savedXdg = process.env.XDG_RUNTIME_DIR;
  const savedDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.XDG_RUNTIME_DIR;
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  return () => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
    if (savedDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = savedDbus;
  };
}

function withDefaultBackend() {
  const saved = process.env.META_SANDBOX_BACKEND;
  delete process.env.META_SANDBOX_BACKEND;
  return () => {
    if (saved === undefined) delete process.env.META_SANDBOX_BACKEND;
    else process.env.META_SANDBOX_BACKEND = saved;
  };
}

// The fail-closed refusal and the fail-closed jail failure both come back as
// results; this pulls the first informative line for a skip reason.
function firstErrorLine(r) {
  const text = String(r.error || r.output || "").trim();
  return text.split("\n").find((l) => l.trim()) || "unknown failure";
}

test("runBwrap delegates to the systemd envelope and returns the shared contract", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  const spawned = [];
  execFileImpl = (file, argv, opts, cb) => {
    spawned.push({ file, argv, opts });
    // Like the real execFile, the callback must arrive asynchronously.
    setImmediate(() => cb(null, "hello", "warn"));
    return { kill() { return false; } };
  };
  try {
    const before = execFileCalls.length;
    const r = await runSandboxed("ls /workspace", { timeoutMs: 7_000 });
    assert.equal(spawned.length, 1, "exactly one envelope spawn");
    assert.ok(execFileCalls.length > before, "the spy must record the spawn");
    const { file, argv, opts } = spawned[0];
    assert.equal(file, "systemd-run", "the bwrap arm runs through systemd-run");
    assert.equal(opts.timeout, 15_000, "outer brake = timeoutMs + 8000");
    const unitIdx = argv.indexOf("--unit");
    assert.notEqual(unitIdx, -1, "the transient unit must be named");
    const unit = argv[unitIdx + 1];
    assert.match(unit, /^meta-sbx-[0-9a-f]{8}$/, "unit = meta-sbx-<uuid8>");
    // Full delegation: exactly buildSystemdArgv(buildBwrapArgv(...), opts, unit).
    assert.deepEqual(argv, buildSystemdArgv(
      buildBwrapArgv("ls /workspace", { timeoutMs: 7_000 }, false),
      { timeoutMs: 7_000 }, unit,
    ));
    // Shared result contract plus the backend tag.
    assert.equal(r.backend, "bwrap");
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.output, "hello\nwarn", "stdout and stderr merged like runDocker");
    assert.equal(r.truncated, false);
    assert.equal(r.timedOut, false);
    assert.equal(typeof r.ms, "number");
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("the host backstop kills the scope and the child at the budget", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  const spawned = [];
  execFileImpl = (file, argv, opts, cb) => {
    spawned.push({ file, argv });
    // Mirror execFile's optional-opts form: the backstop spawns
    // `systemctl --user kill ...` with no opts object (3-arg call).
    const done = typeof opts === "function" ? opts : cb;
    if (file === "systemctl") {     // the scope kill issued by the backstop
      setImmediate(() => done(null, "", ""));
      return { kill() { return false; } };
    }
    if (file === "systemd-run") {   // hangs until the backstop kills the child
      return {
        kill(signal) {
          setImmediate(() => done(
            Object.assign(new Error(`killed by ${signal}`),
              { killed: true, signal, code: null }), "", ""));
        },
      };
    }
    // Any other spawn (a regression to the docker arm) resolves at once, so a
    // red run fails on its assertions instead of hanging.
    setImmediate(() => done(null, "", ""));
    return { kill() { return false; } };
  };
  try {
    const r = await runSandboxed("ls /workspace", { timeoutMs: 150 });
    const runCall = spawned.find((s) => s.file === "systemd-run");
    const killCall = spawned.find((s) => s.file === "systemctl");
    assert.ok(runCall, "the envelope must be spawned");
    assert.ok(killCall, "the backstop must kill the scope");
    const unit = runCall.argv[runCall.argv.indexOf("--unit") + 1];
    assert.deepEqual(killCall.argv,
      ["--user", "kill", "--signal=SIGKILL", `${unit}.scope`],
      "the backstop kills exactly the transient scope it spawned");
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true, "the backstop cut must set timedOut");
    assert.equal(r.exitCode, 137, "a SIGKILL surfaces as 128+9");
    assert.ok(r.ms < 10_000, `the budget must hold (ms=${r.ms})`);
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("runBwrap refuses before spawning anything without a systemd user session", async () => {
  const restoreSession = stubNoUserSession();
  const restoreBackend = withDefaultBackend();
  execFileImpl = (file, argv, opts, cb) => {
    setImmediate(() => cb(null, "", ""));
    return { kill() { return false; } };
  };
  try {
    const before = execFileCalls.length;
    const r = await runSandboxed("ls /workspace");
    assert.equal(r.ok, false);
    assert.equal(r.backend, "bwrap");
    assert.ok(r.error, "a refusal must carry an error");
    assert.match(r.error, /systemd user session/,
      "the error must name the missing prerequisite");
    assert.equal(execFileCalls.length, before, "no process may be started");
    assert.equal(r.output, `${r.error}\n`);
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("runBwrap refuses when the systemd-run binary is not on PATH", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  const savedPath = process.env.PATH;
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), "sbx-no-bin-"));
  process.env.PATH = emptyDir;
  execFileImpl = (file, argv, opts, cb) => {
    setImmediate(() => cb(null, "", ""));
    return { kill() { return false; } };
  };
  try {
    const before = execFileCalls.length;
    const r = await runSandboxed("ls /workspace");
    assert.equal(r.ok, false);
    assert.match(String(r.error), /systemd-run not found on PATH/);
    assert.equal(execFileCalls.length, before, "no process may be started");
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("timedOut comes from exit codes and kill signals, never from stderr wording", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  const cases = [
    { why: "stderr wording alone must not mark a timeout",
      err: null, stderr: "Error: request timed out after 30s", want: false },
    { why: "GNU timeout exit 124",
      err: Object.assign(new Error("failed"), { code: 124 }), want: true, exit: 124 },
    { why: "scope kill exit 137",
      err: Object.assign(new Error("failed"), { code: 137 }), want: true, exit: 137 },
    { why: "killed child with no numeric code",
      err: Object.assign(new Error("failed"),
        { code: null, killed: true, signal: "SIGKILL" }), want: true, exit: 137 },
  ];
  try {
    for (const c of cases) {
      execFileImpl = (file, argv, opts, cb) => {
        setImmediate(() => cb(c.err, "", c.stderr));
        return { kill() { return false; } };
      };
      const r = await runSandboxed("ls /workspace");
      assert.equal(r.timedOut, c.want, c.why);
      if (c.exit !== undefined) assert.equal(r.exitCode, c.exit, c.why);
    }
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("bwrap output is capped at maxOutputBytes with the shared marker (fake)", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  execFileImpl = (file, argv, opts, cb) => {
    setImmediate(() => cb(null, "x".repeat(9000), ""));
    return { kill() { return false; } };
  };
  try {
    const r = await runSandboxed("ls /workspace");
    const marker = "\n[salida truncada]";
    assert.equal(r.backend, "bwrap");
    assert.equal(r.truncated, true);
    assert.ok(r.output.endsWith(marker), "the shared truncation marker must be appended");
    assert.equal(Buffer.byteLength(r.output), 8192 + Buffer.byteLength(marker));
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

// ---- Real-path bwrap execution (jail-gated) ------------------------------------
// One cached trivial run answers whether THIS host can provision the jail. On a
// non-provisioned host it comes back fail-closed (design's verified host facts:
// AppArmor blocks the jail), and the gated tests below skip with its first
// error line instead of failing — the docker-daemon-skip pattern.

let trivialRun = null;
function trivialBwrapRun() {
  if (!trivialRun) trivialRun = runSandboxed("ls /workspace");
  return trivialRun;
}

test("a trivial run through the real bwrap path succeeds or fails closed with an explanation", async () => {
  const restoreBackend = withDefaultBackend();
  try {
    const r = await trivialBwrapRun();
    assert.equal(r.backend, "bwrap", "the default backend must be bwrap");
    if (r.ok) {
      // Provisioned host: the jail ran and the contract holds.
      assert.equal(r.exitCode, 0);
      assert.equal(r.timedOut, false);
      assert.equal(r.truncated, false);
    } else {
      // Non-provisioned host: the refusal or the jail failure must explain
      // itself — never a silent success, never a bare `ok:false`. `error` is
      // the contract's explanation field and names the failing envelope.
      assert.ok(r.error || r.output, "a failed run must explain itself");
      assert.match(String(r.error || r.output), /bwrap|systemd|session/i);
    }
  } finally {
    restoreBackend();
  }
});

test("double brake: sleep 30 under a 5s budget stops in seconds and reports timedOut", async (t) => {
  const seed = await trivialBwrapRun();
  if (!seed.ok) return t.skip(`bwrap jail unavailable on this host: ${firstErrorLine(seed)}`);
  const restoreBackend = withDefaultBackend();
  try {
    const r = await runSandboxed("sleep 30", { allowWrite: true, timeoutMs: 5_000 });
    assert.equal(r.backend, "bwrap");
    assert.equal(r.timedOut, true, "an over-budget command must be marked timedOut");
    assert.ok([124, 137].includes(r.exitCode),
      `exit code must reflect the timeout or kill status, got ${r.exitCode}`);
    assert.ok(r.ms < 10_000, `the command must stop in seconds, not 30 (ms=${r.ms})`);
  } finally {
    restoreBackend();
  }
});

test("a real over-cap output is truncated at maxOutputBytes (jail-gated)", async (t) => {
  const seed = await trivialBwrapRun();
  if (!seed.ok) return t.skip(`bwrap jail unavailable on this host: ${firstErrorLine(seed)}`);
  const restoreBackend = withDefaultBackend();
  try {
    // `seq` is whitelisted: a read-classified command, no allowWrite needed.
    const r = await runSandboxed("seq 1 4000");
    assert.equal(r.backend, "bwrap");
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    const marker = "\n[salida truncada]";
    assert.ok(r.output.endsWith(marker), "the shared truncation marker must be appended");
    assert.equal(Buffer.byteLength(r.output), 8192 + Buffer.byteLength(marker));
  } finally {
    restoreBackend();
  }
});

// ---- Backend-aware selfCheck (phase 4): prereqs, posture, route gate ----------
// Tasks 4.1-4.6. `server.mjs` turns a failing selfCheck into the route's 503,
// so every fail-closed path must come back with an actionable `reason`: an
// invalid backend naming the rejected and accepted values, a missing bwrap
// prerequisite naming it (this host's actual gap is the AppArmor `userns,`
// profile), and an unproven posture dimension naming which one. Probe
// outcomes are faked through the execFile seam so these pins hold on ANY
// host; the real-host variants run the actual probes and skip — never fail —
// where the prerequisite under test is not missing.

// PATH lookup for test gates only (mirrors the module's spawn-free check).
function onPath(bin) {
  return String(process.env.PATH || "").split(path.delimiter).filter(Boolean)
    .some((dir) => {
      try { accessSync(path.join(dir, bin), constants.X_OK); return true; }
      catch { return false; }
    });
}

function withBackend(value) {
  const saved = process.env.META_SANDBOX_BACKEND;
  if (value === undefined) delete process.env.META_SANDBOX_BACKEND;
  else process.env.META_SANDBOX_BACKEND = value;
  return () => {
    if (saved === undefined) delete process.env.META_SANDBOX_BACKEND;
    else process.env.META_SANDBOX_BACKEND = saved;
  };
}

// Fake execution for the selfCheck probes. Each response is keyed on the
// COMMAND TEXT the probe ran (the markers are baked into the probe commands),
// never on call order, so breaking one dimension in isolation is stable. The
// userns prereq spawn succeeds unless `broken.userns` is set. Backend-agnostic:
// the docker and bwrap arms issue the same probe commands.
function fakeSelfCheckExec(broken = {}) {
  execFileImpl = (file, argv, opts, cb) => {
    const cmd = argv.join(" ");
    if (cmd.includes("/bin/true")) {           // the bwrap userns prereq probe
      const stderr = broken.userns ? "bwrap: setting up uid map: Permission denied" : "";
      setImmediate(() => cb(
        broken.userns
          ? Object.assign(new Error("Command failed: bwrap"), { code: 1, stderr })
          : null,
        "", stderr));
      return { kill() { return false; } };
    }
    let stdout = "";
    if (cmd.includes("echo FS_OK")) {
      stdout = broken.fsRead ? "workspace not mounted" : "file.txt\nFS_OK";
    } else if (cmd.includes("NET_LEAK")) {
      stdout = broken.networkBlocked
        ? "NET_LEAK\n1000\nmeta-host"
        : "NET_BLOCKED\n1000\nabc0123def456";
    } else if (cmd.includes("HOME_SEEN")) {
      stdout = broken.hostHomeInvisible
        ? "file.txt\nHOME_SEEN"
        : "ls: cannot access: No such file or directory\nHOME_HIDDEN";
    }
    setImmediate(() => cb(null, stdout, ""));
    return { kill() { return false; } };
  };
}

test("selfCheck fails closed on an invalid backend, naming the rejected and accepted values", async () => {
  const restoreBackend = withBackend("podman");
  try {
    const before = execFileCalls.length;
    const r = await selfCheck();
    assert.equal(r.ok, false);
    assert.ok(r.reason, "an invalid backend must fail closed with a reason");
    assert.match(r.reason, /podman/, "the reason must name the rejected value");
    assert.match(r.reason, /bwrap/, "the reason must name the accepted set");
    assert.match(r.reason, /docker/, "the reason must name the accepted set");
    assert.equal(execFileCalls.length, before, "no probe may spawn for an invalid backend");
  } finally {
    restoreBackend();
  }
});

test("bwrap selfCheck needs all four posture dimensions and names the unproven ones", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  try {
    // All four proven -> ok:true with no reason.
    fakeSelfCheckExec();
    let r = await selfCheck();
    assert.equal(r.ok, true);
    assert.equal(r.backend, "bwrap");
    assert.equal(r.reason, null);

    // Each dimension that the fake can break fails ok on its own, and the
    // reason names exactly it (task 4.3: ok:false whenever one is unproven).
    for (const dim of ["fsRead", "networkBlocked", "hostHomeInvisible"]) {
      fakeSelfCheckExec({ [dim]: true });
      r = await selfCheck();
      assert.equal(r.ok, false, `${dim} unproven must fail ok`);
      assert.equal(r.backend, "bwrap");
      assert.match(String(r.reason), /unproven bwrap posture/);
      assert.match(String(r.reason), new RegExp(dim));
    }
    // writeBlocked can never drop through this fake: the write probe is
    // refused by the shared policy BEFORE any spawn (pinned at the top of
    // this file), so there is no execFile call to fake. It feeds `ok` through
    // the same dimension verdict as the others, proven green above.
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("selfCheck on bwrap fails closed naming the AppArmor userns prerequisite when the userns probe fails", async (t) => {
  if (!onPath("bwrap")) return t.skip("bwrap binary not on PATH");
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  // This host's captured bwrap denial for the prereq probe, faked so the pin
  // holds on provisioned hosts too (the real-probe variant is below).
  const stderr = "bwrap: setting up uid map: Permission denied";
  execFileImpl = (file, argv, opts, cb) => {
    setImmediate(() => cb(
      Object.assign(new Error("Command failed: bwrap"), { code: 1, stderr }), "", stderr));
    return { kill() { return false; } };
  };
  try {
    const before = execFileCalls.length;
    const r = await selfCheck();
    assert.equal(r.ok, false);
    assert.equal(r.backend, "bwrap");
    assert.match(String(r.reason), /user-namespace creation failed/);
    assert.match(String(r.reason), /uid map/, "the reason must carry the captured probe detail");
    assert.match(String(r.reason), /AppArmor/i, "the reason must name the AppArmor prerequisite");
    assert.match(String(r.reason), /userns,/, "the reason must name the profile permission");
    // Fail closed BEFORE any posture probe: only the one prereq spawn ran.
    assert.deepEqual(execFileCalls.slice(before).map((c) => c[0]), ["bwrap"]);
    for (const dim of ["writeBlocked", "fsRead", "networkBlocked", "hostHomeInvisible"]) {
      assert.equal(r[dim], false, `an unproven ${dim} must not claim to be proven`);
    }
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
  }
});

test("the real bwrap selfCheck fails closed with an AppArmor/userns reason on this host", async (t) => {
  const restoreBackend = withDefaultBackend();
  try {
    const r = await selfCheck();
    if (!/user-namespace creation failed/i.test(String(r.reason || ""))) {
      return t.skip(`the userns prerequisite is not failing here: ` +
                    (r.ok ? "all prerequisites proven" : String(r.reason)));
    }
    assert.equal(r.ok, false);
    assert.equal(r.backend, "bwrap");
    assert.match(String(r.reason), /AppArmor/i);
  } finally {
    restoreBackend();
  }
});

test("the full bwrap posture verifies when the host prerequisites are met", async (t) => {
  // Gate per task 4.5: bwrap, systemd-run --user, and a readable
  // /etc/apparmor.d/bwrap profile. A missing prerequisite skips with its
  // captured reason — never fails (design: "must skip, not fail").
  if (!existsSync("/etc/apparmor.d/bwrap")) {
    return t.skip("AppArmor profile /etc/apparmor.d/bwrap is absent");
  }
  if (!onPath("bwrap") || !onPath("systemd-run")) {
    return t.skip("bwrap and/or systemd-run missing on PATH");
  }
  const bus = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "bus")
    : (String(process.env.DBUS_SESSION_BUS_ADDRESS || "").match(/(?:^|,)unix:path=([^,]+)/) || [])[1];
  if (!bus || !existsSync(bus)) return t.skip("no usable systemd user session (bus socket)");
  const restoreBackend = withDefaultBackend();
  try {
    const r = await selfCheck();
    assert.equal(r.backend, "bwrap");
    assert.equal(r.writeBlocked, true);       // refused by policy, never executed
    assert.equal(r.fsRead, true);             // workspace mounted and readable
    assert.equal(r.networkBlocked, true);     // --unshare-all: the fetch cannot leave
    assert.equal(r.hostHomeInvisible, true);  // the host home path does not resolve
    assert.equal(r.ok, true);
    // The denied write probe never executed, so the workspace stays clean.
    const defaultWorkdir = process.env.META_SANDBOX_WORKDIR || "/home/test/test";
    assert.equal(existsSync(defaultWorkdir + "/.sandbox-probe"), false);
  } finally {
    restoreBackend();
  }
});

test("the docker self-check runs no bwrap prerequisite, so a missing profile cannot gate it", async () => {
  const restoreBackend = withBackend("docker");
  fakeSelfCheckExec();
  try {
    const before = execFileCalls.length;
    const r = await selfCheck();
    assert.equal(r.ok, true);
    assert.equal(r.backend, "docker");
    assert.equal(r.reason, null);
    const spawns = execFileCalls.slice(before).map((c) => c[0]);
    assert.ok(spawns.length > 0, "the docker posture must actually probe");
    assert.ok(spawns.every((f) => f === "docker"),
      `only docker spawns are allowed on the docker arm, got: ${JSON.stringify(spawns)}`);
  } finally {
    execFileImpl = realExecFile;
    restoreBackend();
  }
});

// ---- Persistent root (phase 5): creation, layout, reuse ----------------------
// Task 5.1: a bwrap run creates META_BWRAP_ROOT with mode 0700 and the
// bin/lib/home/tmp layout on first use, then REUSES the same directory on
// later runs — persistence is the spec'd semantic change from docker's
// ephemeral filesystem. Everything runs through mkdtemp paths via the
// `bwrapRoot` opt: the suite must never create, write or delete the host's
// real ~/sandbox. Execution is faked through the spy seam, so these pins are
// host-independent (no AppArmor profile, no real systemd scope needed).

test("runBwrap creates the sandbox root layout 0700 on first use and reuses it", async () => {
  const restoreSession = stubUserSession();
  const restoreBackend = withDefaultBackend();
  const parent = mkdtempSync(path.join(os.tmpdir(), "sbx-root-"));
  const root = path.join(parent, "sandbox");   // deliberately NOT created yet
  const spawned = [];
  execFileImpl = (file, argv, opts, cb) => {
    spawned.push({ file, argv });
    setImmediate(() => cb(null, "", ""));
    return { kill() { return false; } };
  };
  try {
    // First run: the layout must appear from nothing, BEFORE the bind.
    const first = await runSandboxed("ls /workspace", { bwrapRoot: root });
    assert.equal(first.ok, true);
    for (const dir of ["bin", "lib", "home", "tmp"]) {
      assert.ok(statSync(path.join(root, dir)).isDirectory(),
        `${dir}/ must be laid out on first use`);
    }
    assert.equal(statSync(root).mode & 0o777, 0o700,
      "the persistent root must be private to the operator (0700)");
    const run = spawned.find((s) => s.file === "systemd-run");
    assert.ok(run, "the envelope must be spawned");
    const bindIdx = run.argv.indexOf("--bind");
    assert.notEqual(bindIdx, -1, "the sandbox root must be bound");
    assert.deepEqual([run.argv[bindIdx + 1], run.argv[bindIdx + 2]], [root, "/sandbox"],
      "the root must be bound at /sandbox");
    const inode = statSync(root).ino;

    // Second run: the SAME directory is reused — a marker written between
    // runs must survive, proving the root is not recreated per command.
    writeFileSync(path.join(root, "home", "marker"), "keep-me");
    const second = await runSandboxed("ls /workspace", { bwrapRoot: root });
    assert.equal(second.ok, true);
    assert.equal(statSync(root).ino, inode, "the root must be reused, not recreated");
    assert.equal(readFileSync(path.join(root, "home", "marker"), "utf8"), "keep-me",
      "state written under the root must survive between commands");
  } finally {
    execFileImpl = realExecFile;
    restoreSession();
    restoreBackend();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a file written by a write-enabled bwrap run persists into a later read run (jail-gated)", async (t) => {
  // Task 5.2. Gated on the cached real-jail probe: on a host that cannot
  // provision the jail this SKIPS with the captured first error line — never
  // fails (design: "must skip, not fail"). The root lives under mkdtemp and
  // is removed in finally, so the suite never touches the real ~/sandbox.
  const seed = await trivialBwrapRun();
  if (!seed.ok) return t.skip(`bwrap jail unavailable on this host: ${firstErrorLine(seed)}`);
  const restoreBackend = withDefaultBackend();
  const parent = mkdtempSync(path.join(os.tmpdir(), "sbx-persist-"));
  const root = path.join(parent, "sandbox");
  try {
    // A write-enabled run plants an artifact under the sandbox root.
    const writeRun = await runSandboxed("echo persisted-artifact > /sandbox/artifact",
      { bwrapRoot: root, allowWrite: true });
    assert.equal(writeRun.backend, "bwrap");
    assert.equal(writeRun.ok, true, `the write run must succeed: ${firstErrorLine(writeRun)}`);
    const inode = statSync(root).ino;

    // A LATER read run in the same root must see the artifact, non-empty.
    const readRun = await runSandboxed("cat /sandbox/artifact", { bwrapRoot: root });
    assert.equal(readRun.ok, true, `the read run must succeed: ${firstErrorLine(readRun)}`);
    const seen = String(readRun.output || "").trim();
    assert.ok(seen.length > 0, "the earlier artifact must be present and non-empty");
    assert.equal(seen, "persisted-artifact",
      "the artifact written by the earlier command must still be visible");

    // The same root directory was reused, not recreated per command.
    assert.equal(statSync(root).ino, inode, "the root must be reused, not recreated");
    assert.ok(statSync(path.join(root, "artifact")).size > 0,
      "the artifact must also be visible to the host under META_BWRAP_ROOT");
  } finally {
    restoreBackend();
    rmSync(parent, { recursive: true, force: true });
  }
});
