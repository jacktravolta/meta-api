# Proposal: Local Enslaved-Directory Sandbox (bwrap backend)

## Intent

The agent executes model-authored shell commands inside an ephemeral Docker container
(`agent/sandbox.js`, image `meta-sandbox:1`, 232 MB). Docker's cost is real and measured:
~700–900 ms of overhead per command, a heavy base image, and a running daemon — a poor fit for
single-operator local execution where the actual containment need is "confine this process to a
directory, no network, no host reach". We want the same security posture at native speed.

This change adds a **selectable local backend**: a `bwrap` (bubblewrap) sandbox that runs each
command inside a user namespace with a minimal, enjaulado root — the workspace plus read-only
system paths — no host home, no network by default, and resource caps applied through
`systemd-run`. The workspace becomes a **persistent per-sandbox directory** where the operator
(user running the broker) may install tooling; installations stay inside that directory and use
only the executing user's permissions. Docker remains available as a fallback and strict mode.

## Scope

### In Scope

- **Backend selection**: `META_SANDBOX_BACKEND=docker|bwrap` (env), **default `bwrap`** (explicit user decision: the sandbox must NOT be Docker); `docker` stays selectable
  current behavior unless explicitly opted in. Implemented behind the existing
  `runSandboxed(command, {allowWrite, allowNetwork, workdir, timeoutMs})` interface so callers
  (`agent/loop.js`, `server.mjs`) are untouched.
- **bwrap confinement**: persistent sandbox root (`META_BWRAP_ROOT`, default `~/sandbox`);
  minimal read-only binds (`/usr`, `/lib`, `/lib64`, `/bin`, a minimal `/etc`); `--proc /proc`
  and `--dev /dev`; workspace bound read-only, read-write only under `allowWrite` + ack;
  `--unshare-all` with network re-enabled only under `allowNetwork`; `--die-with-parent`.
- **Resource limits via `systemd-run`**: bwrap has no cgroups, so memory/CPU/PID caps are applied
  by wrapping execution in `systemd-run --user --scope -p MemoryMax=… -p CPUQuota=… -p TasksMax=…`
  to preserve parity with the Docker memory/CPU/pids envelope.
- **`selfCheck` per backend**: probe that network is blocked by default, the host home is
  invisible, and the workspace is confined to the sandbox root; same gate semantics (route
  `503` when the active backend does not prove its posture).
- **Timeouts and output caps preserved**: inner timeout plus host-side backstop, and the
  configured max-output truncation marker, reimplemented for the bwrap process tree.
- **Coexistence**: Docker path stays as-is; no removal.

### Out of Scope

- **Removing Docker** — it remains a supported backend and strict/fallback mode.
- **API authentication** — unchanged; localhost binding is still the only control.
- **`apt` inside the jail** — no root, no escalation inside the namespace; "installing" means
  user-prefix package managers (`pip --target`, `npm --prefix`) writing inside the sandbox only.
- **Multi-user support** — single-operator local deployment only.
- **Automatic AppArmor profile installation** — shipping/configuring `/etc/apparmor.d/bwrap` is a
  documented host prerequisite, not something the agent loop performs.

## Capabilities

### New Capabilities

- `agent-sandbox-backend`: the pluggable backend contract — `META_SANDBOX_BACKEND` selection and
  default, backend-agnostic `runSandboxed` interface, the bwrap confinement posture (persistent
  root, minimal read-only binds, `--unshare-all`, `--die-with-parent`), the `systemd-run` resource
  envelope, and per-backend `selfCheck` with the shared route gate.

### Modified Capabilities

- `agent-sandbox-hardening`: the execution-posture requirements become backend-scoped rather than
  Docker-only — "Docker execution posture" and "Network isolation by default" MUST generalize to
  "active backend posture"; "Self-check proves the default posture" MUST verify the active
  backend; the `meta-sandbox:1` image contract MUST remain Docker-only while bwrap has no image.

## Approach

`agent/sandbox.js` gains a backend dispatcher. `classify()` and the deny-by-default policy stay
**unchanged and shared** — the security boundary is the same regardless of backend. After a
command passes classification, `runSandboxed` branches:

- `bwrap` (default): the new jailed-directory backend (user decision).
- `docker` (opt-in via env): the existing ephemeral `docker run --rm` path, untouched.
- `bwrap`: build a `bwrap` argv that binds the workspace at `/workspace` (`:ro` unless the
  command is a qualifying write with `allowWrite`), binds `/usr`, `/lib`, `/lib64`, `/bin` and a
  minimal `/etc` read-only, sets `--proc /proc --dev /dev`, unsets host home, and applies
  `--unshare-all` (adding the network namespace back only when `allowNetwork`). The command is
  wrapped in `systemd-run --user --scope` with `MemoryMax`, `CPUQuota`, and `TasksMax` derived
  from the same defaults (`256m`, `1` CPU, `100` PIDs), then in an inner `timeout` for the
  process-group brake. A host-side backstop kills the process tree at the budget. `HOME` points
  inside the sandbox root so `pip --target` / `npm --prefix` installs land in the sandbox.

Facts verified on the host: `bwrap 0.9.0` is already installed (Ubuntu 24.04.4, kernel 7.0.0).
**Blocker**: `kernel.apparmor_restrict_unprivileged_userns=1` with no bwrap AppArmor profile, so
bwrap fails to create user namespaces. The fix is a host prerequisite profile
`/etc/apparmor.d/bwrap` granting `userns,` with `flags=(unconfined)` — **not** disabling the
global sysctl. The self-check must fail closed (route `503`) when this prerequisite is absent.

Docker remains the default, so switching backends is opt-in and the strict Docker mode is always
one env change away.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `agent/sandbox.js` | Modified | Backend dispatch; bwrap argv builder; `systemd-run` wrapper; per-backend `runSandboxed` and `selfCheck`; shared `classify()` retained |
| `agent/sandbox.test.js` | Modified | Add classifier parity tests and bwrap argv/selfCheck tests behind the backend seam |
| `server.mjs` | Modified | Surface the active backend in the self-check gate/error path (same `503` behavior) |
| `README.md` | Modified | Document `META_SANDBOX_BACKEND`, `META_BWRAP_ROOT`, the AppArmor prerequisite, and package-install semantics |
| `openspec/specs/agent-sandbox-hardening/spec.md` | Modified | Delta: generalize posture/network/self-check requirements to the active backend |
| `openspec/changes/bwrap-sandbox/specs/agent-sandbox-backend/spec.md` | New | Delta spec for the backend-selection capability |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Data leak via a forgotten or over-broad bind (e.g. binding host `/etc` fully or the home dir) | Med | Keep binds explicit and minimal; self-check asserts host home is invisible and only the sandbox root is reachable; prefer an allowlist over `--ro-bind / /` |
| Resource limits silently absent when `systemd-run` (systemd user session) is unavailable | Med | Detect at startup/self-check; either refuse to start bwrap mode or fail closed to `503`; document the `systemd --user` prerequisite; never run unlimited silently |
| AppArmor `userns` restriction blocks bwrap (`apparmor_restrict_unprivileged_userns=1`) | High | Ship the documented `/etc/apparmor.d/bwrap` profile (`userns,` + `flags=(unconfined)`); do not weaken the global sysctl; self-check fails closed if the profile is missing |
| Drift of the persistent sandbox directory (unbounded installs, stale state across runs) | Med | Document the persistent root as operator-managed; use a disk-budget note and per-run cleanup guidance; keep the directory out of the workspace unless intended |
| Behavioral divergence between Docker and bwrap breaks agent expectations | Low | Shared classifier and output/result contract; backend-agnostic tests; Docker stays default until parity is verified |
| `systemd-run --user` and cgroup delegation differ across distros | Low | Treat systemd user scopes as a prerequisite and validate in `selfCheck`; keep Docker as fallback |

## Rollback Plan

1. **Runtime switch**: set `META_SANDBOX_BACKEND=docker` (or remove it) and restart the broker —
   the existing Docker path is unchanged and remains the default. No data migration is involved
   (`pending-jobs.json` / `state.json` are gitignored runtime state; the `~/sandbox` directory is
   disposable).
2. **Code**: revert the `agent/sandbox.js` backend-dispatch commit range; the Docker path is
   preserved intact, so `git revert` restores the prior behavior without touching `agent/loop.js`.
3. **Host prerequisite**: the `/etc/apparmor.d/bwrap` profile is optional for Docker mode and can
   be left in place or removed; the global sysctl was never modified, so no security posture is
   weakened by rolling back.
4. **Tests/docs**: revert `README.md` and `agent/sandbox.test.js` additions to return to the
   current baseline.

## Dependencies

- `bwrap` (bubblewrap) on the host — **present: 0.9.0**.
- A systemd **user** session with cgroup delegation (`systemd-run --user --scope`) for
  memory/CPU/PID limits.
- Host AppArmor profile `/etc/apparmor.d/bwrap` with `userns,` + `flags=(unconfined)` while
  `kernel.apparmor_restrict_unprivileged_userns=1` is set.
- Docker daemon with `meta-sandbox:1` only for the Docker backend (default).
- Node.js 22 native `node:test`; no new npm dependencies.

## Success Criteria

- [ ] `META_SANDBOX_BACKEND=bwrap` runs commands through the same
      `runSandboxed(command, {allowWrite, allowNetwork, workdir, timeoutMs})` interface with no
      caller changes.
- [ ] Functional parity with Docker for reads, gated writes, denied writes, and network-off
      behavior; `classify()` decisions are identical across backends.
- [ ] Command startup overhead is in the **low milliseconds** (well under the ~700–900 ms Docker
      path), measured on a trivial command.
- [ ] Memory, CPU, and PID limits are **effective** under bwrap (proven by an exceeding command
      being killed/limited), not merely requested.
- [ ] `selfCheck` is green on bwrap: network blocked, host home invisible, workspace confined to
      the sandbox root, limits proven; absent prerequisites yield route `503` (fail closed).
- [ ] Package installs (`pip --target`, `npm --prefix`) land inside the sandbox root with the
      executing user's permissions; no `apt`, no privilege escalation inside the jail.
- [ ] `node --test 'agent/*.test.js'` passes with the new backend tests, and the Docker backend
      remains the default.
