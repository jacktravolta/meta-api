// Pins for the sandbox policy probe (selfCheck): each sub-probe command must
// classify the way its assertion needs. The write probe MUST classify as write —
// that is what makes the default policy refuse it before any container exists,
// so nothing can ever be written to the host. These command strings mirror
// selfCheck on purpose: if a probe is rephrased into something the policy would
// let through, this suite must fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./sandbox.js";

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
