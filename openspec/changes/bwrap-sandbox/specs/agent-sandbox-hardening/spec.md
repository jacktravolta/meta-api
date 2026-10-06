# Delta for agent-sandbox-hardening

This delta generalizes the execution-posture requirements from Docker-only to the active
backend, keeps the `meta-sandbox:1` image contract Docker-only, and adds the documented host
prerequisite that the `bwrap` backend depends on. The classifier, read-only whitelist, write
gating, timeout/output contract, and route gate remain unchanged.

## ADDED Requirements

### Requirement: bwrap host prerequisites verified by the self-check

The `bwrap` backend SHALL require documented host prerequisites: the `bwrap` binary, a usable
systemd user session for `systemd-run --user --scope`, and an AppArmor profile
`/etc/apparmor.d/bwrap` granting `userns,` (with `flags=(unconfined)`) while
`kernel.apparmor_restrict_unprivileged_userns=1` is set. The self-check SHALL verify these
prerequisites for the active backend. When any prerequisite is missing, the self-check MUST
report `ok: false` (fail closed) and the route gate MUST answer `503`. The system MUST NOT
weaken the global sysctl and MUST NOT execute `bwrap` commands without user namespaces.

#### Scenario: A missing AppArmor profile fails the self-check closed

- GIVEN `kernel.apparmor_restrict_unprivileged_userns=1` and no `/etc/apparmor.d/bwrap` profile
- WHEN the self-check runs with the `bwrap` backend active
- THEN `ok` MUST be false
- AND the reason MUST identify the missing `userns,` AppArmor prerequisite
- AND the route MUST answer `503` instead of running commands

#### Scenario: The documented profile unblocks bwrap

- GIVEN `/etc/apparmor.d/bwrap` grants `userns,` with `flags=(unconfined)`
- WHEN the self-check runs with the `bwrap` backend active
- THEN user-namespace creation MUST succeed
- AND this prerequisite MUST NOT cause `ok` to be false

#### Scenario: A missing bwrap binary fails closed

- GIVEN the `bwrap` binary is not available on the host
- WHEN the self-check runs with the `bwrap` backend active
- THEN `ok` MUST be false
- AND no command MUST be executed without confinement

#### Scenario: A missing systemd user session fails closed

- GIVEN `systemd-run --user` or a usable systemd user session is unavailable
- WHEN the self-check runs with the `bwrap` backend active
- THEN `ok` MUST be false
- AND no command MUST be executed without resource limits

#### Scenario: Docker does not require the bwrap prerequisites

- GIVEN the `docker` backend is active and the bwrap prerequisites are absent
- WHEN the self-check runs
- THEN the missing bwrap prerequisites MUST NOT make `ok` false

## MODIFIED Requirements

### Requirement: Active backend execution posture

Every executed command MUST run under the active backend's hardened posture. Under the `bwrap`
backend it MUST run inside the user-namespace directory jail defined by `agent-sandbox-backend`;
under the `docker` backend it MUST run in an ephemeral container with a read-only root, all
capabilities dropped, and no new privileges. In both backends the command MUST have capped
memory, CPUs and PIDs, `HOME` redirected inside the sandbox, and the workspace exposed at
`/workspace`. The default resource envelope SHALL be memory 256m, 1 CPU, PID limit 100, and shell
`/bin/sh`. The `meta-sandbox:1` image SHALL apply only to the `docker` backend.
(Previously: named "Docker execution posture" and Docker-only; it now covers whichever backend is
active.)

#### Scenario: The docker backend runs with the hardened container flags

- GIVEN any command that passes classification and the active backend is `docker`
- WHEN it is executed
- THEN the container MUST start with `--rm`, `--read-only`, `--cap-drop=ALL`, and `--security-opt=no-new-privileges`
- AND it MUST be constrained by the memory, CPU and PID limits

#### Scenario: The bwrap backend runs inside the user-namespace jail

- GIVEN any command that passes classification and the active backend is `bwrap`
- WHEN it is executed
- THEN it MUST run inside the user-namespace jail, not on the host root
- AND it MUST be constrained by the memory, CPU and PID limits

#### Scenario: The active backend applies the default envelope

- GIVEN the default configuration for either backend
- WHEN a command is executed
- THEN the memory, CPU and PID caps MUST default to 256m, 1 CPU and 100 PIDs
- AND `HOME` MUST be redirected inside the sandbox

### Requirement: Active backend workspace confinement

The workspace SHALL be exposed to the executed command read-only. It SHALL be exposed read-write
only when the command classifies as a write AND write access was explicitly enabled. The
mechanism is backend-specific: the `docker` backend uses a read-only or read-write bind mount
(carrying `:ro` when read-only), and the `bwrap` backend uses a read-only or read-write bind of
the workspace at `/workspace`. In both backends the workspace MUST be confined so the command
cannot reach host paths outside it.
(Previously: named "Read-only workspace unless writes are enabled" and described the Docker mount
only.)

#### Scenario: A read command gets a read-only workspace

- GIVEN a read-classified command under the default policy
- WHEN it is executed on either backend
- THEN the workspace MUST be read-only

#### Scenario: An enabled write exposes the workspace read-write

- GIVEN a write-classified command with write access enabled
- WHEN it is executed on either backend
- THEN the workspace MUST be read-write

#### Scenario: The workspace is confined to the sandbox

- GIVEN a command under either backend
- WHEN it attempts to reach a host path outside the workspace and the sandbox root
- THEN that host path MUST NOT be reachable

### Requirement: Active backend network isolation

Every backend SHALL run commands with network egress disabled by default. Network egress SHALL be
enabled only when network access was explicitly opted in. Under the `docker` backend the default
MUST be `--network none` and opt-in MUST use `bridge`; under the `bwrap` backend the default MUST
be `--unshare-all` with the network namespace isolated, and opt-in MUST expose the host network
namespace back to the jail.
(Previously: named "Network isolation by default" and specified the Docker network mode only.)

#### Scenario: Default network is disabled on either backend

- GIVEN a command under default options
- WHEN it executes on the `docker` backend
- THEN its network MUST be `none`
- AND when it executes on the `bwrap` backend its network MUST be isolated by `--unshare-all`

#### Scenario: Opt-in network is granted

- GIVEN a command with network access enabled
- WHEN it executes on the `docker` backend
- THEN its network MUST be `bridge`
- AND when it executes on the `bwrap` backend the host network namespace MUST be available

### Requirement: Self-check proves the active backend posture

The sandbox self-check SHALL probe the posture of the active backend rather than assuming Docker.
The write probe MUST classify as a write and MUST be refused by the policy layer before any
backend process exists, so `writeBlocked:true` means the command was denied by policy and never
executed. A read-classified filesystem probe MUST execute and prove the workspace is exposed and
readable. A trusted, statically authored probe MUST verify that network access is blocked by
default and that the host home identity is invisible. The self-check SHALL report `ok` only when
all four hold, and it MUST verify the prerequisites of the active backend. Absent or failed
prerequisites MUST yield `ok: false`, and the route gate MUST answer `503`.
(Previously: named "Self-check proves the default posture" and assumed the Docker default.)

#### Scenario: The write probe is denied by policy, not executed

- GIVEN the default policy on the active backend
- WHEN the self-check write probe runs
- THEN `writeBlocked` MUST be true
- AND no probe artifact MUST be created in the host workspace

#### Scenario: The full bwrap posture verifies

- GIVEN the `bwrap` backend with its host prerequisites met
- WHEN the self-check runs
- THEN `writeBlocked`, `fsRead`, `networkBlocked` and `hostHomeInvisible` MUST all be true
- AND `ok` MUST be true

#### Scenario: The full docker posture verifies

- GIVEN the `docker` backend and a reachable Docker daemon
- WHEN the self-check runs
- THEN `writeBlocked`, `fsRead`, `networkBlocked` and `hostHomeInvisible` MUST all be true
- AND `ok` MUST be true

#### Scenario: An unproven posture is not accepted

- GIVEN the active backend cannot prove one of the four posture properties, or a prerequisite is missing
- WHEN the self-check runs
- THEN `ok` MUST be false
- AND the route gate MUST answer `503`

### Requirement: Sandbox image contract

The sandbox image SHALL be `meta-sandbox:1`, built from the agent sandbox Dockerfile, and SHALL
bake in the tooling the agent is expected to use (`php-cli` and `curl`) so common commands do not
require network installs at run time. This requirement SHALL apply only when the active backend
is `docker`. When the active backend is `bwrap`, no image SHALL be involved and this requirement
MUST NOT gate execution.
(Previously: applied unconditionally; it is now scoped to the Docker backend.)

#### Scenario: The docker default image carries the expected tooling

- GIVEN the active backend is `docker` and the default sandbox image
- WHEN a command invokes the baked-in tools
- THEN they MUST be available without installing anything

#### Scenario: The bwrap backend does not require the image

- GIVEN the active backend is `bwrap` and `meta-sandbox:1` is absent
- WHEN a command is executed
- THEN the image contract MUST NOT block execution

## RENAMED Requirements

### Requirement: Docker execution posture → Active backend execution posture

(Reason: the posture now applies to whichever backend is active, not Docker alone.)
(Migration: any reference or test naming "Docker execution posture" should use "Active backend
execution posture".)

### Requirement: Read-only workspace unless writes are enabled → Active backend workspace confinement

(Reason: the workspace is bound read-only/read-write on both backends, not only mounted by Docker.)
(Migration: any reference or test naming "Read-only workspace unless writes are enabled" should
use "Active backend workspace confinement".)

### Requirement: Network isolation by default → Active backend network isolation

(Reason: default network isolation is enforced by the active backend, Docker or bwrap.)
(Migration: any reference or test naming "Network isolation by default" should use "Active
backend network isolation".)

### Requirement: Self-check proves the default posture → Self-check proves the active backend posture

(Reason: the self-check must verify the posture and prerequisites of the active backend.)
(Migration: any reference or test naming "Self-check proves the default posture" should use
"Self-check proves the active backend posture".)
