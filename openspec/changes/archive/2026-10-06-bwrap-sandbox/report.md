# Archive Report: bwrap-sandbox

> Terminal record of the SDD cycle for the `bwrap-sandbox` change. The change added a selectable
> local `bwrap` sandbox backend behind the existing `runSandboxed` interface, generalized the
> hardening posture from Docker-only to the active backend, and promoted its delta specs into the
> source of truth. This report describes the state of the change AT CLOSE.

- **Change**: `bwrap-sandbox`
- **Store**: openspec (repo-local)
- **Archived to**: `openspec/changes/archive/2026-10-06-bwrap-sandbox/`
- **Archive date**: 2026-10-06
- **Branch**: `feat/bwrap-sandbox`
- **Cycle status**: complete (all tasks checked; specs promoted; all commits on the branch, `main` untouched)

## Final Status

The change is **complete and archived**. All 37 tasks across 6 phases are marked `[x]` in
`tasks.md`; the two delta specs have been promoted into `openspec/specs/`. The implementation lives
on branch `feat/bwrap-sandbox`; `main` is untouched.

Commit range for this change: **6 commits**, `18ba365..e887fb0` (`git rev-list --count
18ba365^..e887fb0` = 6):

```
18ba365 feat(agent): add backend seam and pure bwrap argv builders
0091160 fix(agent): return flags-only systemd argv and normalize the spy seam
2128d0c feat(agent): run bwrap through a systemd user scope with a double brake
549dace feat(agent): gate the agent route on a backend-aware selfCheck
73db66e feat(agent): persist the bwrap root and document host prerequisites
e887fb0 test(agent): pin cross-backend parity and verify the docker rollback
```

A later, separate commit `a542ed6 fix(meta-api): keep the Meta tab live while backgrounded` is
**not part of this change**: `git merge-base --is-ancestor a542ed6 e887fb0` is false. It is not
counted in the range and is not described here.

No `verify-report.md` was produced for this change (verification was carried as final-state facts
in the archive launch and in `tasks.md` "Global Acceptance Criteria"). This is recorded, not treated
as a failure.

## Capabilities Promoted

| Capability | Action | Details | Promoted spec path |
|-----------|--------|---------|--------------------|
| `agent-sandbox-hardening` | Updated | 4 requirements renamed + modified, 1 modified (scoped to Docker), 1 added; 4 unrelated requirements preserved | `openspec/specs/agent-sandbox-hardening/spec.md` |
| `agent-sandbox-backend` | Created | 10 requirements added; capability did not exist | `openspec/specs/agent-sandbox-backend/spec.md` |

`agent-sandbox-hardening` was composed with the native
`gentle-ai sdd-archive-compose --canonical openspec/specs/agent-sandbox-hardening/spec.md
--delta openspec/changes/bwrap-sandbox/specs/agent-sandbox-hardening/spec.md
--output openspec/specs/agent-sandbox-hardening/spec.md.compose-tmp` (exit 0), then atomically
moved into place with `mv`. The composed spec now holds 11 requirements:

- **Renamed + modified** (RENAMED applied before the same-change MODIFIED, so the old name is
  visible to the modification):
  - `Docker execution posture` → **Active backend execution posture**
  - `Read-only workspace unless writes are enabled` → **Active backend workspace confinement**
  - `Network isolation by default` → **Active backend network isolation**
  - `Self-check proves the default posture` → **Self-check proves the active backend posture**
- **Modified** (not renamed): `Sandbox image contract` (now scoped to the Docker backend).
- **Added**: `bwrap host prerequisites verified by the self-check`.
- **Preserved byte-for-byte**: `Deny-by-default command classification`, `Read-only whitelist`,
  `Write gating with explicit opt-in`, `Double timeout brake and output cap`, and `Route gate on
  sandbox verification`.

`agent-sandbox-backend` did not exist as a main spec, so the delta spec (a full spec, not a delta)
was copied mechanically with shell `cp` + `diff -r` readback (empty output) and `mv`. Its 10
requirements are: Backend selection by environment; Backend-agnostic execution interface and result
contract; bwrap directory jail with a persistent root; Minimal read-only system binds and device
mounts; Workspace confinement and write gating under bwrap; Network isolation via user namespace
with explicit opt-in; Parent-death process cleanup; Resource limits enforced through a systemd user
scope; Equivalent double timeout brake under bwrap; Confined user-prefix installations without
privilege escalation.

## Verification Evidence

- **Automated suite**: `cd /home/test/test/meta-api && node --test 'agent/*.test.js'` →
  **80 tests / 73 passed / 0 failed / 7 skipped** (re-confirmed at archive time on `feat/bwrap-sandbox`).
  The 7 skips are jail-gated with explicit reasons (`bwrap jail unavailable on this host: ...`,
  `AppArmor profile /etc/apparmor.d/bwrap is absent`, `bwrap and/or systemd-run missing on PATH`,
  `no usable systemd user session (bus socket)`, `pip3 not usable inside the jail: ...`). They are
  honest skips, not green-passing fakes.
- **Task completion**: `tasks.md` is 37/37 `[x]`, 0 pending.
- **Resource limits are effective, not merely requested**: the `buildSystemdArgv` envelope imposes
  `MemoryMax=256M`/`CPUQuota=100%`/`TasksMax=100`. A 512 MB allocation in python under the bwrap
  backend received SIGKILL in 310 ms — the scope killed it.
- **Docker path preserved verbatim**: `runDocker` is byte-identical to the pre-change
  `runSandboxed` body except the dispatch-seam lines (signature `(command, opts, needsWrite)` and
  `const o = opts;`, replacing the removed local `DEFAULTS` merge / `classify()` / write-gate head
  now in the dispatcher). A normalized `diff` of the two bodies shows only those seam lines changed.
- **Offline install path valid on this host**: `pip3 install --target` works despite PEP 668
  (externally-managed-environment), so the acceptance-F install test is meaningful rather than a
  trivially skipped assertion.
- **Fail-closed posture**: with the bwrap jail unavailable (see Accepted Limits), `runSandboxed`
  refuses instead of degrading to an unconfined host execution.

## What Shipped

The broker gained a pluggable sandbox backend inside `agent/sandbox.js`, behind the unchanged
`runSandboxed(command, {allowWrite, allowNetwork, workdir, timeoutMs})` interface — callers
(`agent/loop.js`, `server.mjs`) need no backend-specific arguments:

- **Backend selection** — `META_SANDBOX_BACKEND` (`bwrap` default, `docker` explicit); any other
  value fails closed with an error naming the rejected and accepted values, never a silent fallback.
- **Shared policy, per-backend execution** — `classify()` and the deny-by-default write gate stay
  the single security boundary; only the execution stage branches (`runDocker` / `runBwrap`).
- **bwrap directory jail** — persistent root `META_BWRAP_ROOT` (default `~/sandbox`, `0700`, layout
  `bin/ lib/ home/ tmp/`), minimal read-only system binds (`/usr` plus usrmerge symlinks and an
  allowlisted `/etc`), `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, no host home, no full host
  root, `--unshare-all` by default with network re-enabled only under `allowNetwork`,
  `--die-with-parent`.
- **Resource envelope** — `systemd-run --user --scope` with `MemoryMax=256M`, `CPUQuota=100%`,
  `TasksMax=100`, and a host-side backstop that kills the scope; missing `systemd-run --user` fails
  closed.
- **Backend-aware `selfCheck`** — probes the active backend's prerequisites and the four posture
  dimensions (`writeBlocked`, `fsRead`, `networkBlocked`, `hostHomeInvisible`); `POST /v1/agent`
  answers `503` when any is unproven.
- **Docs** — `README.md` documents `META_SANDBOX_BACKEND`, `META_BWRAP_ROOT`, the AppArmor profile
  prerequisite (`/etc/apparmor.d/bwrap` with `userns,` + `flags=(unconfined)`), user-prefix install
  semantics, and rollback.

## Known Pending / Accepted Limits

- **The bwrap jail cannot be exercised on this host.** When run through `systemd-run`, the jail
  fails to create its loopback with `RTM_NEWADDR: Operation not permitted`. The design is
  **fail-closed**: it refuses to execute in 19–32 ms rather than degrading to an unconfined or
  unlimited run. This is exactly why the 7 jail-gated tests are skipped with an explicit reason
  instead of being faked green. This is the central accepted limit of the change; the bwrap posture
  is verified by unit tests on the pure builders and by the fail-closed probes, not by a live jail
  end-to-end run on this machine.
- **Persistent-root drift.** `META_BWRAP_ROOT` is operator-managed and survives between commands by
  design; unbounded installs are the operator's responsibility (README carries a disk-budget/cleanup
  note), and the root is isolated from the workspace.
- **Residual classifier indirection vector.** The read-only whitelist is textual, not a shell AST
  parser; real containment remains the bind policy plus `--unshare-all`. Unchanged from the prior
  Docker posture.
- **`systemd-run --user` portability.** Memory/CPU/PID limits depend on a usable systemd user
  session and memory-controller delegation; the self-check catches absence and fails closed.
- **Open design questions.** `design.md` still lists four unchecked Open Questions (identity user
  namespace reading, `HOME=/sandbox/home` vs the proposal's `/workspace`, memory-controller
  delegation on target hosts, and whether to ship an example AppArmor file). They are recorded here
  as open, not as resolved.

## Delivery Status

- The work lives on branch **`feat/bwrap-sandbox`** (the 6-commit range above), delivered as
  single-purpose work units. `main` is intact.
- **Merge / PR is pending the user's decision.** No merge to `main` and no PR was opened during this
  SDD cycle. `tasks.md` recommended a feature-branch chain; the commits are the chain.
- The archive phase performed a `git mv` of the tracked change folder into
  `openspec/changes/archive/2026-10-06-bwrap-sandbox/` (openspec/ is git-tracked).
- **No implementation code was modified by the archive phase.** Only `openspec/specs/` and the
  archived change folder were touched.

## Archive Integrity

- **Spec composition**: `gentle-ai sdd-archive-compose` exit 0 for `agent-sandbox-hardening`
  (native name-matching merge; renamed-before-modified ordering). The composed canonical was
  checked equal to the inspected preview with `diff -r` (empty).
- **New capability copy**: `diff -r` between the archived delta
  `openspec/changes/archive/2026-10-06-bwrap-sandbox/specs/agent-sandbox-backend/spec.md` and the
  promoted `openspec/specs/agent-sandbox-backend/spec.md` was empty (byte-identical).
- **Archive move**: verified via a recursive pre-move snapshot `diff -r` against the destination —
  empty output (byte-identical), with the source verified absent before the readback.
- **Preserved inside the archive**: `proposal.md`, `design.md`, `tasks.md`, and `specs/**`
  (2 capabilities). This `report.md` is additive and did not exist in the source change folder.
- **Active changes directory** no longer contains `bwrap-sandbox`; `openspec/specs/` contains both
  `agent-sandbox-hardening/` and `agent-sandbox-backend/`.
