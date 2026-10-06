# Design: Local Enslaved-Directory Sandbox (bwrap backend)

## Technical Approach

Add a selectable sandbox backend to `agent/sandbox.js` behind the existing
`runSandboxed(command, {allowWrite, allowNetwork, workdir, timeoutMs})` interface. The policy layer
(`classify()` + write gating) is shared and unchanged: it remains the single security boundary.
Only the execution stage branches:

- `bwrap` (default): assemble a user-namespace directory jail with `bwrap`, wrapped in a
  `systemd-run --user --scope` resource envelope, with a persistent per-sandbox root
  (`META_BWRAP_ROOT`, default `~/sandbox`).
- `docker` (opt-in via `META_SANDBOX_BACKEND=docker`): the current ephemeral `docker run --rm`
  path, extracted into its own function but behaviorally identical.

`selfCheck()` becomes backend-aware and fails closed (`ok:false` → route `503`) whenever the
active backend cannot prove its posture or a prerequisite is missing. This implements the
`agent-sandbox-backend` capability and the generalized `agent-sandbox-hardening` delta.

**Verified host facts (this machine):** `bwrap` 0.9.0 and `systemd-run` (systemd 255.4) are
present; `kernel.apparmor_restrict_unprivileged_userns = 1`; `/etc/apparmor.d/bwrap` is absent; the
user manager reports `degraded` but reachable; `/bin`, `/lib`, `/lib64`, `/sbin` are usrmerge
symlinks into `/usr`. An unprivileged `bwrap` invocation fails today (`setting up uid map:
Permission denied`), so the AppArmor profile is a hard prerequisite, exactly as the proposal states.

## Architecture Decisions

### Decision: Dispatch by backend while keeping `classify()` shared

**Choice**: `runSandboxed` resolves the active backend, runs the shared write-gating check, then
dispatches to `runDocker(...)` or `runBwrap(...)`. `classify()` and the `WRITE_MARKERS` /
`READ_ONLY` tables are untouched.

**Alternatives considered**: (a) a backend registry object with per-backend `classify`; (b) two
public entry points (`runSandboxedDocker`, `runSandboxedBwrap`).

**Rationale**: The spec makes classification identity across backends a hard requirement
(`agent-sandbox-backend`), and the classifier is already the tested security boundary (the entire
existing suite pins it). A registry with per-backend classifiers would invite divergence.
Two public entry points would break the "no caller changes" requirement. Dispatch-only branching
keeps the security surface fixed while the execution surface varies.

### Decision: Default backend is `bwrap`, invalid values fail closed

**Choice**: `resolveBackend()` reads `META_SANDBOX_BACKEND`; unset/empty → `bwrap`; `bwrap` and
`docker` accepted; anything else returns a typed error carrying the rejected value. The error
propagates to both `runSandboxed` (refuses, no process spawned) and `selfCheck` (`ok:false`,
`reason` naming the rejected value and the accepted set).

**Alternatives considered**: silent fallback to `docker` on an invalid value.

**Rationale**: This is an explicit user decision and the spec's "invalid backend fails closed"
scenario. Silent fallback would execute model-authored text under a backend the operator did not
choose, which is the opposite of fail-closed. Naming both the rejected and accepted values makes
the 503 actionable.

### Decision: bwrap jail root is a persistent operator-owned directory

**Choice**: Bind `META_BWRAP_ROOT` (default `~/sandbox`, created `0700` on first use) into the jail
at `/sandbox`, readable-writable for every run. Layout:

```
~/sandbox/
├── bin/     # user-prefix binaries; first entry on PATH
├── lib/     # pip --target / npm --prefix destination
├── home/    # HOME for the jail
└── tmp/     # reserved operator scratch (jail uses a tmpfs /tmp instead)
```

**Alternatives considered**: (a) a fresh `mkdtemp` root per command (ephemeral, Docker-like);
(b) bind the sandbox root read-only unless `allowWrite`.

**Rationale**: Persistence is a deliberate semantic change requested by the proposal: installs and
state must survive between commands. Binding it read-write always (rather than gating it with
`allowWrite`) is safe because it is the sandbox's own dedicated directory, not host-sensitive
state; the *workspace* remains the only gated host path. This mirrors Docker's writable
`/tmp`-as-`HOME`: tools need a writable home for caches even on read-classified commands. A
per-command temp root would defeat persistence and re-introduce install churn.

### Decision: No uid remap — the jail runs as the executing user

**Choice**: Do not pass `--uid`/`--gid` and do not request a fake root. The process keeps the
executing user's identity (`id -u` == the broker's uid, `1000` here). Namespaces are requested via
`--unshare-all` (or the explicit set below when network is opted in).

**Alternatives considered**: `--unshare-user --uid 0` (fake root inside the jail); a setuid
`bwrap` binary.

**Rationale**: This is the explicit user decision ("same uid"). It prevents inside-jail privilege
escalation: with no root and no caps, `sudo`/`apt` have no target. Two clarifications are
load-bearing and must be documented for the implementer:

1. **An unprivileged `bwrap` always creates a user namespace, even with no `--unshare-*` flags** —
   it needs that namespace to assemble the mount namespace. Verified on this host: a plain
   `bwrap --ro-bind ... -- /bin/true` still fails at `setting up uid map`. Therefore "no
   `--unshare-user`" cannot mean "no user namespace"; it means "no *identity change*". The
   AppArmor `userns,` profile is what authorizes that namespace. This resolves the apparent tension
   between the user note and the spec's mandatory `--unshare-all`.
2. identity user namespaces map the current uid to itself, so `id -u` stays `1000` inside — the
   "same uid" property holds without a remap.

### Decision: Resource limits via `systemd-run --user --scope`, fail closed if absent

**Choice**: Wrap the full `bwrap` argv in
`systemd-run --user --scope --quiet --unit meta-sbx-<uuid> -p MemoryMax=256M -p CPUQuota=100% -p
TasksMax=100 -- bwrap ...`. `MemoryMax` `256M`, `CPUQuota=100%` (= 1 CPU), `TasksMax=100` match the
Docker defaults (`--memory 256m --cpus 1 --pids-limit 100`).

**Alternatives considered**: (a) rely on `bwrap` alone (it has no cgroup support); (b) a
`systemd-run --scope` under the *system* manager (requires root); (c) no limits and a documented
warning.

**Rationale**: `bwrap` isolates namespaces but does not enforce memory/CPU/PID caps; without the
scope the envelope would be silently absent, which the spec forbids. A user scope needs no root and
matches the single-operator deployment. Option (c) is explicitly rejected by the spec: "never run
unlimited silently". If `systemd-run --user` or a usable user manager is unavailable, or the memory
controller is not delegated, the prerequisite probe fails and the route answers `503`.

### Decision: Minimal read-only system binds via an allowlist (no `--ro-bind / /`)

**Choice**: Bind `/usr` read-only, recreate the usrmerge symlinks (`/bin`, `/lib`, `/lib64`,
`/sbin`), mount `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, and assemble a minimal `/etc` from an
explicit file/directory allowlist with `--ro-bind-try`. Never bind the host home or the host root.

**Alternatives considered**: (a) `--ro-bind / /` then overlay; (b) bind all of `/etc`.

**Rationale**: A full-root bind makes every host path visible unless individually masked — a
forgotten mask is a leak, the exact risk in the proposal. An allowlist inverts the failure mode: a
forgotten entry makes a tool fail, not a secret leak. Binding all of `/etc` would expose host
identity/secret material; the allowlist keeps only what dynamic linking, name resolution and TLS
need. `--ro-bind-try` tolerates distro variation without aborting the run.

### Decision: Network via namespace omission, not a share flag

**Choice**: Default (no network) uses `--unshare-all`. With `allowNetwork`, enumerate the
namespaces explicitly **without** the network namespace:
`--unshare-user --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup` (no `--unshare-net`).

**Alternatives considered**: `--unshare-all` plus a hypothesized `--share-net` (bubblewrap has no
such flag).

**Rationale**: The spec says "opt-in MUST expose the host network namespace back to the jail". The
only mechanism bubblewrap offers is *not* unsharing the net namespace, so the explicit enumeration
is required. It keeps every other namespace isolated on opt-in runs.

## Data Flow

```
POST /v1/agent
   │  verify !== false
   ▼
selfCheck() ──► resolveBackend()
   │                 ├─ invalid ─────────────► { ok:false, reason } ──► 503 (names rejected value)
   │                 ├─ docker ─► dockerSelfCheck()  (existing probes)
   │                 └─ bwrap  ─► prereq probes ──► posture probes ──► { ok:false } ──► 503
   ▼ ok:true
agent loop ──► runSandboxed(cmd, {allowWrite, allowNetwork, workdir, timeoutMs})
   │
   ├─ classify(cmd)                      [SHARED, unchanged]
   ├─ needsWrite && !allowWrite ────────► { denied:true }  (no process)
   ├─ resolveBackend() error ───────────► { ok:false, error }  (no process)
   │
   ├─ docker ──► runDocker(cmd,o)        (extracted verbatim from today's path)
   │
   └─ bwrap  ──► runBwrap(cmd,o)
                    buildBwrapArgv()      [pure, unit-tested]
                    buildSystemdArgv()    [pure, unit-tested]
                    execFile("systemd-run", argv, {timeout: timeoutMs + 8000})
                    host timer ──► systemctl --user kill --signal=SIGKILL meta-sbx-<id>.scope
                    ──► { ok, exitCode, output, truncated, ms, timedOut, backend }
```

Build-time bwrap sequence (inside `buildBwrapArgv`):

```
systemd-run --user --scope -q --unit meta-sbx-X
  -p MemoryMax=256M -p CPUQuota=100% -p TasksMax=100
  -- bwrap --die-with-parent --unshare-all
       --ro-bind /usr /usr
       --symlink usr/bin /bin    --symlink usr/lib /lib
       --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin
       --ro-bind-try /etc/passwd /etc/passwd
       --ro-bind-try /etc/group /etc/group
       --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf
       --ro-bind-try /etc/hosts /etc/hosts
       --ro-bind-try /etc/ld.so.cache /etc/ld.so.cache
       --ro-bind-try /etc/ssl /etc/ssl
       --ro-bind-try /etc/ca-certificates.conf /etc/ca-certificates.conf
       --ro-bind-try /etc/localtime /etc/localtime
       [ --ro-bind-try /etc/resolv.conf /etc/resolv.conf          # ONLY allowNetwork
         --ro-bind-try /run/systemd/resolve /run/systemd/resolve ]  # ONLY allowNetwork
       --proc /proc  --dev /dev  --tmpfs /tmp
       --bind <META_BWRAP_ROOT> /sandbox
       --ro-bind <workdir> /workspace            # rw (--bind) iff needsWrite && allowWrite
       --chdir /workspace
       --setenv HOME /sandbox/home
       --setenv PATH /sandbox/bin:/usr/local/bin:/usr/bin:/bin
       --setenv TMPDIR /tmp
       -- /bin/sh -c "timeout <secs> /bin/sh -c <JSON-quoted command>"
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `agent/sandbox.js` | Modify | Add `BACKENDS`, `resolveBackend`, `buildBwrapArgv`, `buildSystemdArgv`, `runBwrap`; extract current body into `runDocker`; make `runSandboxed` dispatch; split `selfCheck` into `dockerSelfCheck`/`bwrapSelfCheck` + prerequisite probes; extend `DEFAULTS` with `backend` and `bwrapRoot`. `classify()` unchanged. |
| `agent/sandbox.test.js` | Modify | Add pure argv-builder tests, backend-resolution/fail-closed tests, classifier-parity pin, and a prerequisite-gated bwrap `selfCheck` test. Keep all 38 existing tests green. |
| `server.mjs` | Modify | `POST /v1/agent` gate: include the active backend and the fail-closed reason in the `503` body; no route-level branching beyond what `selfCheck` returns. |
| `README.md` | Modify | Document `META_SANDBOX_BACKEND` (default `bwrap`), `META_BWRAP_ROOT`, the AppArmor profile prerequisite (with the exact profile text), and user-prefix install semantics. |
| `openspec/specs/agent-sandbox-hardening/spec.md` | Modify (at archive) | Merge the generalized active-backend requirements. Not touched during this phase. |

## Interfaces / Contracts

```js
// Result contract — same fields as today, plus `backend`.
// { ok, exitCode, output, truncated, ms, timedOut, backend?, denied?, error? }

export const BACKENDS = ["bwrap", "docker"];

// Pure. Returns { backend } or { error } naming the rejected and accepted values.
export function resolveBackend(env = process.env.META_SANDBOX_BACKEND) {}

// Pure, exported for unit tests. `needsWrite` comes from the shared classify().
export function buildBwrapArgv(command, opts, needsWrite) {}   // -> ["bwrap", ...]

// Pure. Normalizes memory ("256m" -> "256M") and cpus ("1" -> "100%").
export function buildSystemdArgv(bwrapArgv, opts, unit) {}      // -> ["systemd-run", ...]

// Per-backend posture probe; `ok` requires every dimension AND the prerequisites.
export async function selfCheck() {}
// bwrap prereqs: bwrap binary, userns creation, systemd-run --user.
// Dimensions: writeBlocked, fsRead, networkBlocked, hostHomeInvisible (same names as today).
```

`DEFAULTS` gains:

```js
const DEFAULTS = {
  // ...existing fields unchanged...
  backend: undefined,                                  // resolved at call time
  bwrapRoot: process.env.META_BWRAP_ROOT || path.join(os.homedir(), "sandbox"),
};
```

## Limits, Timeouts and Exit Codes

- **Limits**: `MemoryMax=256M`, `CPUQuota=100%`, `TasksMax=100` — the systemd equivalents of
  Docker's `--memory 256m --cpus 1 --pids-limit 100`. Enforcement is by the user scope; there is no
  `bwrap`-native cgroup path.
- **Double brake**:
  - Inner: `timeout <ceil(timeoutMs/1000)>` runs *inside* the jail and kills the command's process
    group, so the jail does not keep running.
  - Outer: a host timer at `timeoutMs` runs `systemctl --user kill --signal=SIGKILL
    meta-sbx-<id>.scope` and kills the `execFile` child; `--die-with-parent` terminates any
    remaining jail process when the broker dies.
- **Exit codes**: GNU `timeout` returns `124`; a scope SIGKILL surfaces as `137` (`128+9`). Both,
  plus `err.killed`/`err.signal`, set `timedOut:true` — never stderr wording alone. This mirrors the
  Docker branch exactly.
- **Output cap**: unchanged — `maxOutputBytes` (8192) with the truncation marker.

## Persistence Semantics

| Aspect | `docker` (ephemeral) | `bwrap` (persistent) |
|---|---|---|
| Root FS | image, `--read-only` | jail assembled per run from host binds |
| Workspace | bind mount, `:ro` unless write+ack | `/workspace`, `--ro-bind` unless write+ack |
| Home | `HOME=/tmp` (tmpfs, discarded) | `HOME=/sandbox/home` (persistent) |
| Installs | lost when the container exits | persist under `META_BWRAP_ROOT` |
| Root identity | not bound | `/sandbox` bound read-write (sandbox-owned) |

Installations use user-prefix modes only (`pip --target`, `npm --prefix`, `pip install --user` with
`HOME=/sandbox/home`); `PATH` starts with `/sandbox/bin` so installed entry points resolve. No
`sudo`, no `apt` — those classify as writes and, with no root and no caps in the jail, have no
escalation path.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `buildBwrapArgv` shape: `--unshare-all` on default; network set omits `--unshare-net` when `allowNetwork`; `/workspace` is `--ro-bind` by default and `--bind` only for write+`allowWrite`; no host-home or `/` bind; `/etc` entries are the allowlist; `HOME=/sandbox/home`; command passed as a single JSON-quoted argv element | Pure function assertions (no process spawn) |
| Unit | `buildSystemdArgv`: `MemoryMax=256M`, `CPUQuota=100%`, `TasksMax=100`, unit name, `--` separator before the bwrap argv | Pure function assertions |
| Unit | `resolveBackend`: unset → `bwrap`; `docker` → `docker`; `podman` → error naming rejected + accepted values | Pure function assertions |
| Unit | Fail-closed execution: invalid backend → `runSandboxed` returns an error result and starts no process; denied write → `denied:true` and no process (spy on `execFile`) | `node:test` with an injected `execFile` seam or a stubbed module |
| Unit (parity) | `classify()` returns identical decisions under both backends (it is shared; pin that the dispatch does not re-classify) | Reuse existing classifier matrix; add a dispatch test |
| Unit | `bwrapSelfCheck` reports `ok:false` with a reason naming the missing AppArmor/userns prerequisite when the real userns probe fails | Run the probe; assert `ok:false` and reason |
| Integration | Full bwrap posture (`writeBlocked`, `fsRead`, `networkBlocked`, `hostHomeInvisible`, `ok:true`) when prerequisites are met | `t.skip` when `bwrap`/`systemd-run`/profile prerequisites are absent (same pattern as the current Docker skip) |
| Regression | All 38 existing tests remain green | `cd /home/test/test/meta-api && node --test 'agent/*.test.js'` |

The bwrap integration test **must skip, not fail**, on a host without the AppArmor profile, exactly
as the current Docker test skips without a daemon — otherwise the suite would be red on every
non-provisioned host.

## Threat Matrix

This change alters subprocess execution and the composition of a shell command into an argv, so the
matrix is reviewed. The decisive boundary is the new argv builder, which treats model-authored text
as data and host paths as an allowlist.

| Boundary | Minimum adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths | `requirements.txt`, `CMakeLists.txt`, executable Markdown/MDX, `README.sh` | N/A: the change adds no extension-based classification; `classify()` is textual and unchanged, so no doc path gains execution authority | n/a | n/a |
| Git repository selection | `git -C`, relative/absolute paths | N/A: no VCS automation is introduced; git reads run inside the jail exactly as before | n/a | n/a |
| Commit state | staged, `commit -a`, empty index | N/A: `git commit` classifies as write and is gated by the shared policy, unchanged | n/a | n/a |
| Push state | tracking branch, first push, refspec | N/A: no push automation | n/a | n/a |
| PR commands | `--head`, env prefix, composed commands | N/A: no PR automation | n/a | n/a |
| **Command text → argv** (new, subprocess boundary) | command containing `;`, `$(...)`, quotes, or a leading `-`; `workdir` containing spaces/symlinks; `allowWrite`/`allowNetwork` toggled independently | Applicable | Command is passed as one JSON-quoted element to `/bin/sh -c` inside a nested `timeout`; `workdir` is already realpath-validated by `server.mjs` before it reaches the builder; the jail exposes only allowlisted binds | (1) default argv binds `/workspace` ro and contains no host-home/`/` bind; (2) `allowNetwork` alone never makes the workspace writable; (3) `allowWrite` alone never re-adds `--unshare-net`; (4) a command with `;`/`$()` stays a single argv element and is never interpolated into the bwrap flag list |

## Migration / Rollout

- **Feature flag**: `META_SANDBOX_BACKEND` selects the backend. The default flips from Docker to
  `bwrap`; `docker` remains fully intact and is one env change away. There is no data migration:
  `pending-jobs.json` / `state.json` are gitignored runtime state, and `~/sandbox` is disposable.
- **Operator prerequisite before enabling the new default**: install `/etc/apparmor.d/bwrap` on
  Ubuntu 24.04 hosts where `kernel.apparmor_restrict_unprivileged_userns=1`:

  ```
  abi <abi/4.0>,
  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  ```

  then `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. Until it is present, the bwrap self-check
  fails closed and `POST /v1/agent` answers `503` — the intended posture, not a bug.
- **Rollback**: set `META_SANDBOX_BACKEND=docker` and restart the broker, or `git revert` the
  `agent/sandbox.js` dispatch range. The Docker path is preserved intact, so no caller
  (`agent/loop.js`, `server.mjs`) needs a change. The AppArmor profile is optional for Docker mode
  and can be left or removed; the global sysctl was never modified.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Data leak via a forgotten or over-broad bind | Med | Allowlisted binds only (no `--ro-bind / /`, no host home); `buildBwrapArgv` unit tests assert absence of host-home/root binds and `:ro` by default; `selfCheck` proves the host home is invisible |
| Resource limits silently absent (`systemd-run --user` or memory delegation missing) | Med | Prerequisite probe in `bwrapSelfCheck`; fail closed `503`; never run unlimited |
| AppArmor blocks user namespaces (`apparmor_restrict_unprivileged_userns=1`, no profile) | High (present today) | Documented profile prerequisite; selfCheck runs a *real* userns probe and reports the AppArmor/userns reason; never weaken the global sysctl |
| Persistent-root drift (unbounded installs, stale state) | Med | Operator-managed documented root, `0700`, isolated from the workspace; README documents a disk-budget/cleanup note |
| `--unshare-user` wording vs the mandatory `--unshare-all` | Med | Documented decision: unprivileged bwrap always needs an identity user namespace; the jail keeps the same uid and never remaps to root |
| `HOME=/sandbox/home` vs the illustrative `/workspace` in the proposal sketch | Low | Resolved here: `HOME` lives under `META_BWRAP_ROOT` so installs persist independently of a possibly read-only workspace |
| Broken `/etc/resolv.conf` symlink (`../run/systemd/resolve/...`) | Low | Only bound when `allowNetwork`; `/run/systemd/resolve` bound alongside it |
| Behavioral divergence between Docker and bwrap | Low | Shared classifier and result contract; backend-agnostic tests; Docker stays selectable |

## Open Questions

- [ ] Confirm that identity user namespaces (same uid, no remap) are the accepted reading of "no
      `--unshare-user`". The design cannot avoid the namespace on an unprivileged host; the
      alternative is a setuid `bwrap`, which is rejected here.
- [ ] Confirm `HOME=/sandbox/home` (persistent, under `META_BWRAP_ROOT`) rather than the
      illustrative `HOME=/workspace` from the proposal sketch.
- [ ] Confirm the target hosts delegate the memory controller to `systemd --user` so `MemoryMax`
      applies to a user scope (the self-check catches this, but it drives the operator runbook).
- [ ] Decide whether to ship an example AppArmor profile file in the repo or keep the profile
      docs-only (the proposal scopes it as a documented host prerequisite).
