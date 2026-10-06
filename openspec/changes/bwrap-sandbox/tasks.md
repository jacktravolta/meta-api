# Tasks: Local Enslaved-Directory Sandbox (bwrap backend)

Implementation is **not started**: every task below is unchecked. The work lives in
`agent/sandbox.js` (backend dispatch + pure builders + execution + self-check), `agent/sandbox.test.js`
(unit/integration pins) and `README.md` (operator runbook). `classify()` and the write gate stay
shared and unchanged across backends.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~350–500 (additions dominate; ~30–60 deletions from the `runDocker` extraction) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (backend seam + pure builders) → PR 2 (bwrap execution + self-check gate) → PR 3 (persistent root + docs + parity) |
| Delivery strategy | ask-on-risk (no strategy was supplied with this launch; defaulted) |
| Chain strategy | pending (user decision required) |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium
```

Honest note: the central estimate sits on the 400-line boundary. The pure-builder and timeout
tests, the bwrap self-check probe, and the AppArmor/profile text in the README are what push the
upper half past the budget, so chained slices are recommended even though a compact single PR is
conceivable. A decision is needed before apply for two reasons: (a) the chain strategy is not yet
chosen, and (b) this change flips the default backend to `bwrap`, which changes runtime posture for
an operator who has not installed the AppArmor prerequisite.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Backend seam + pure `resolveBackend` / `buildBwrapArgv` / `buildSystemdArgv` + unit tests | PR 1 | `cd /home/test/test/meta-api && /home/test/.nvm/versions/node/v22.23.3/bin/node --test 'agent/sandbox.test.js'` | N/A — pure functions, no process spawn (assert argv arrays only) | Revert the dispatch + builder additions in `agent/sandbox.js` and their tests; the existing Docker body is untouched |
| 2 | `runBwrap` (systemd envelope + double timeout brake) + backend-aware `selfCheck` + route gate | PR 2 (base: PR 1 branch in a feature-branch chain) | `cd /home/test/test/meta-api && /home/test/.nvm/versions/node/v22.23.3/bin/node --test 'agent/*.test.js'` | `META_SANDBOX_BACKEND=bwrap node -e "import('./agent/sandbox.js').then(m=>m.selfCheck()).then(console.log)"` on a host with `/etc/apparmor.d/bwrap` installed | Revert `runBwrap` and `bwrapSelfCheck`; restoring `runSandboxed` to the Docker branch recovers prior behavior |
| 3 | Persistent root, AppArmor prerequisite docs, install semantics, classifier parity pin, README | PR 3 (base: PR 2 branch) | `cd /home/test/test/meta-api && /home/test/.nvm/versions/node/v22.23.3/bin/node --test 'agent/*.test.js'` | Run a write-enabled `pip --target /sandbox/lib` (or `npm --prefix /sandbox/lib`) inside a bwrap run and assert the artifact lands under `META_BWRAP_ROOT` | Revert README + parity/persistence tests; no runtime behavior changed beyond the documented persistent root |

## Phase 1: Backend Seam and Fail-Closed Dispatch

- [ ] 1.1 Add `BACKENDS = ["bwrap", "docker"]` and extend `DEFAULTS` in `agent/sandbox.js` with `backend: undefined` (resolved at call time) and `bwrapRoot: process.env.META_BWRAP_ROOT || path.join(os.homedir(), "sandbox")`. Import `os` and `path`. Verify: module still imports and existing tests load.
- [ ] 1.2 Write RED tests for `resolveBackend` in `agent/sandbox.test.js`: unset/empty → `bwrap`; `"docker"` → `docker`; `"podman"` → error object naming the rejected value and the accepted set `bwrap`/`docker`. Verify: tests fail because `resolveBackend` does not exist yet.
- [ ] 1.3 Implement the pure `resolveBackend(env = process.env.META_SANDBOX_BACKEND)` in `agent/sandbox.js`, returning `{ backend }` or a typed `{ error }` for an invalid value. Verify: 1.2 tests pass.
- [ ] 1.4 Write a RED test that an invalid `META_SANDBOX_BACKEND` makes `runSandboxed` return an error result and starts no process (spy/stub on `execFile`); and that a denied write still returns `denied:true` with no process. Verify: test fails until dispatch exists.
- [ ] 1.5 Extract today's `runSandboxed` Docker body verbatim into `runDocker(command, opts, needsWrite)` in `agent/sandbox.js`; rewrite `runSandboxed` to resolve the backend, run the shared `classify()` write gate first, then dispatch to `runDocker`. Invalid backend → error result, no process. Verify: 1.4 passes; behavior identical on the Docker path.

## Phase 2: Pure argv Builders (Jail + systemd Envelope)

- [ ] 2.1 Write RED tests for `buildBwrapArgv` in `agent/sandbox.test.js` pinning the threat-matrix cases before implementation:
      (a) the default argv binds `/workspace` read-only and contains no host-home or host-root bind;
      (b) `allowNetwork` alone never makes the workspace writable;
      (c) `allowWrite` alone never re-adds `--unshare-net` / never disables `--unshare-all`;
      (d) a command containing `;`, `$(...)`, backticks or quotes stays a single JSON-quoted argv element and is never interpolated into the bwrap flag list.
      Also pin the bind matrix (`/usr`, `/lib`, `/lib64`, `/bin`, minimal `/etc` allowlist; `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`), `--die-with-parent`, and `HOME=/sandbox/home` / `PATH` starting with `/sandbox/bin`.
      Verify: tests fail because the builder does not exist.
- [ ] 2.2 Implement `buildBwrapArgv(command, opts, needsWrite)` in `agent/sandbox.js` per `design.md`: allowlisted read-only binds with usrmerge symlinks (`/bin`→`usr/bin`, `/lib`→`usr/lib`, `/lib64`→`usr/lib64`, `/sbin`→`usr/sbin`), minimal `/etc` via `--ro-bind-try`, `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, `--bind <bwrapRoot> /sandbox`, `/workspace` as `--ro-bind` unless `needsWrite && allowWrite` (then `--bind`), `--chdir /workspace`, `--unshare-all` by default or the explicit namespace set without `--unshare-net` when `allowNetwork`, `--die-with-parent`, and env `HOME`/`PATH`/`TMPDIR`. Verify: 2.1 passes.
- [ ] 2.3 Write RED tests for `buildSystemdArgv` in `agent/sandbox.test.js`: `MemoryMax=256M`, `CPUQuota=100%`, `TasksMax=100`, unit name `meta-sbx-<id>`, the `--` separator before the bwrap argv, and normalization (`256m` → `256M`, `1` → `100%`). Verify: tests fail.
- [ ] 2.4 Implement the pure `buildSystemdArgv(bwrapArgv, opts, unit)` in `agent/sandbox.js`. Verify: 2.3 passes.
- [ ] 2.5 Run the unit tests for phases 1–2 and confirm no regression in the pre-existing 38 tests. Verify: `cd /home/test/test/meta-api && /home/test/.nvm/versions/node/v22.23.3/bin/node --test 'agent/*.test.js'` is green.

## Phase 3: bwrap Execution, Resource Envelope and Double Timeout Brake

- [ ] 3.1 Implement `runBwrap(command, opts, needsWrite)` in `agent/sandbox.js`: generate `unit = meta-sbx-<uuid8>`, assemble `buildSystemdArgv(buildBwrapArgv(...), opts, unit)`, launch with `execFile("systemd-run", argv, { timeout: opts.timeoutMs + 8000 })`, return the shared result shape plus `backend: "bwrap"`. Verify: a trivial command runs through bwrap when prerequisites are met (or returns a clear fail-closed error when they are not).
- [ ] 3.2 Implement the host-side backstop in `runBwrap`: a timer at `opts.timeoutMs` runs `systemctl --user kill --signal=SIGKILL <unit>.scope` and kills the child; the inner `timeout <ceil(timeoutMs/1000)>` inside the jail is the first brake. Verify: `sleep 30` under a 5 s budget stops in seconds, not 30.
- [ ] 3.3 Preserve the result contract in `runBwrap`: merge stdout+stderr, apply `maxOutputBytes` with the truncation marker, and set `timedOut` from exit code `124`/`137` or `err.killed`/`err.signal` (never from stderr wording alone). Verify: unit tests on a fake/short command pin `timedOut`, output cap and merge.
- [ ] 3.4 Fail closed when `systemd-run --user` or a usable systemd user session is unavailable: `runBwrap` refuses and never executes without limits. Verify: with a stubbed/absent user session, `runSandboxed` returns an error result and starts no unlimited command.
- [ ] 3.5 Write execution tests in `agent/sandbox.test.js` (double brake, `timedOut` detection, output cap, fail-closed without user session); `t.skip` those requiring the real jail when prerequisites are absent. Verify: tests skip cleanly on a non-provisioned host and pass on a provisioned one.

## Phase 4: Backend-Aware selfCheck, Prerequisite Probes and Route Gate

- [ ] 4.1 Split `selfCheck()` in `agent/sandbox.js`: keep the existing probes as `dockerSelfCheck()` (behavior unchanged) and make the exported `selfCheck()` resolve the backend, delegate, and return `ok:false` with a reason naming the rejected+accepted values on an invalid backend. Verify: existing Docker end-to-end test still passes when Docker is reachable.
- [ ] 4.2 Implement `bwrapSelfCheck()` prerequisite probes: `bwrap` binary present; a **real** user-namespace creation succeeds; `systemd-run --user --scope` is usable. On any missing prerequisite return `ok:false` with a reason identifying it (notably the missing `userns,` AppArmor profile when `kernel.apparmor_restrict_unprivileged_userns=1`). Verify: probe reports `ok:false` and a naming reason on this host today.
- [ ] 4.3 Implement the four bwrap posture dimensions in `bwrapSelfCheck()` with the same names as today: `writeBlocked` (policy-denied before any jail process), `fsRead` (workspace readable), `networkBlocked` (default `--unshare-all` blocks egress), `hostHomeInvisible` (host home directory not reachable). `ok` requires prerequisites AND all four. Verify: `ok:false` whenever one dimension is unproven.
- [ ] 4.4 Write a unit test in `agent/sandbox.test.js` asserting `selfCheck()` with `META_SANDBOX_BACKEND=bwrap` reports `ok:false` and a reason naming the missing AppArmor/userns prerequisite when the real userns probe fails. Verify: test passes on a host without the profile.
- [ ] 4.5 Write the integration test for the full bwrap posture (`writeBlocked`, `fsRead`, `networkBlocked`, `hostHomeInvisible`, `ok:true`) that `t.skip`s when `bwrap`, `systemd-run --user`, or `/etc/apparmor.d/bwrap` (read-only) is absent. Verify: skipped on non-provisioned hosts, green on a provisioned one.
- [ ] 4.6 Verify the `docker` backend's self-check is unaffected by missing bwrap prerequisites (docker → `ok:true` with a daemon, independent of the AppArmor profile). Verify: run `selfCheck()` with `META_SANDBOX_BACKEND=docker`; assert no bwrap prerequisite gates it.
- [ ] 4.7 Verify the `POST /v1/agent` gate in `server.mjs` (read-only) already answers `503` when `selfCheck().ok` is false, so no source edit is required for spec compliance; note that surfacing the active backend in the `503` body is an optional enhancement outside this brief's scope. Verify: `503` observed with a missing prerequisite.

## Phase 5: Persistent Root, Host Prerequisites and Install Semantics

- [ ] 5.1 Implement sandbox-root creation in `agent/sandbox.js`: create `META_BWRAP_ROOT` (default `~/sandbox`) with mode `0700` on first use and lay out `bin/`, `lib/`, `home/`, `tmp/` before binding it at `/sandbox`. Verify: running any bwrap command creates the layout once and reuses it.
- [ ] 5.2 Add a persistence test in `agent/sandbox.test.js` (skip without prerequisites): a file written by a write-enabled bwrap run is visible to a later read run in the same root; assert the root is reused, not recreated. Verify: the earlier artifact is present and non-empty on the second run.
- [ ] 5.3 Document in `README.md` the persistent-root semantics (`META_BWRAP_ROOT`, layout, `0700`, survives commands, is disposable) and a disk-budget/cleanup note. Verify: README states the root is operator-managed and isolated from the workspace.
- [ ] 5.4 Document in `README.md` the AppArmor host prerequisite: the path `/etc/apparmor.d/bwrap` (read-only, host-managed), the exact profile text as a fenced example (`abi <abi/4.0>,` + `profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }`), the `apparmor_parser -r` reload step, and an explicit statement that the agent performs **no** automatic installation and never weakens the global sysctl. Verify: a reader can provision the host from the README alone.
- [ ] 5.5 Document in `README.md` the confined install semantics: user-prefix only (`pip --target <sandbox-path>`, `npm --prefix <sandbox-path>`, `pip install --user` with `HOME` inside the root), `PATH` starting with `/sandbox/bin`, and that `sudo`/`su`/`apt`/`apt-get` classify as writes and have no escalation path. Verify: no instruction implies root inside the jail.

## Phase 6: Docker Parity, Documentation and Acceptance

- [ ] 6.1 Add a classifier-parity pin in `agent/sandbox.test.js`: `classify()` returns identical write/read decisions and the same reason for a shared command set regardless of the active backend, and the dispatch does not re-classify. Verify: the pin fails if a per-backend classifier is introduced.
- [ ] 6.2 Run the full suite and confirm every pre-existing test is green alongside the new ones: `cd /home/test/test/meta-api && /home/test/.nvm/versions/node/v22.23.3/bin/node --test 'agent/*.test.js'`. Verify: 38 pre-existing tests plus the new backend tests pass (or skip with an explicit reason).
- [ ] 6.3 Update `README.md` with backend selection and migration/rollback: `META_SANDBOX_BACKEND` (default `bwrap`), the accepted values, the `docker` fallback/strict mode, the prerequisites, and the rollback step (set `META_SANDBOX_BACKEND=docker` or `git revert`). Verify: the runbook covers selection, prerequisites, limits and rollback.
- [ ] 6.4 Verify the rollback path: `META_SANDBOX_BACKEND=docker` restores the untouched Docker behavior with no caller changes to `agent/loop.js` (read-only) or `server.mjs` (read-only). Verify: a Docker run behaves as before the change.

## Global Acceptance Criteria

- [ ] A. Functional parity with Docker for reads, enabled writes, denied writes and network-off behavior; `classify()` decisions are identical across backends.
- [ ] B. Command startup overhead is in the low milliseconds on a trivial command, well under the ~700–900 ms Docker path.
- [ ] C. Resource limits are effective under bwrap (`MemoryMax=256M`, `CPUQuota=100%`, `TasksMax=100`): an over-limit command is constrained or killed, not merely requested.
- [ ] D. `selfCheck` is green on bwrap with prerequisites met (network blocked, host home invisible, workspace confined, limits proven); absent prerequisites yield `503` (fail closed).
- [ ] E. All 38 pre-existing tests remain green and the Docker backend remains selectable and behaviorally unchanged.
- [ ] F. No privilege escalation inside the jail; `pip --target` / `npm --prefix` installs land under `META_BWRAP_ROOT`, owned by the executing user.
