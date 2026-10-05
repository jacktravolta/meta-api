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
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { classify, selfCheck } from "./sandbox.js";

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

// ---- End-to-end selfCheck (docker) -------------------------------------------

async function dockerReachable() {
  try {
    await promisify(execFile)("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    return true;
  } catch { return false; }
}

test("selfCheck enforces the whole default posture", async (t) => {
  if (!(await dockerReachable())) return t.skip("docker no disponible");
  const r = await selfCheck();
  assert.equal(r.writeBlocked, true);       // the write attempt was refused by policy
  assert.equal(r.fsRead, true);             // the workspace mounted and is readable
  assert.equal(r.networkBlocked, true);     // --network none: the fetch cannot leave
  assert.equal(r.hostHomeInvisible, true);  // container hostname, never the host's
  assert.equal(r.ok, true);
  // The denied write probe never executed, so the host workspace stays clean.
  const defaultWorkdir = process.env.META_SANDBOX_WORKDIR || "/home/test/test";
  assert.equal(existsSync(defaultWorkdir + "/.sandbox-probe"), false);
});
