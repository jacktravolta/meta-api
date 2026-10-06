# Agent Sandbox Hardening Specification

## Purpose

Define the isolation contract that makes model-authored shell commands safe to execute: the
deny-by-default classifier, the Docker execution posture, the read/write and network gating,
the double timeout brake, the output cap, and the self-check that proves the default posture is
actually enforced before any agent work starts.

## Requirements

### Requirement: Deny-by-default command classification

The command classifier SHALL classify a command as a write unless every shell segment matches
the read-only whitelist. Segments SHALL be split on `|`, `;` and `&`, and one non-read segment
MUST poison the whole chain. The classifier MUST treat as writes any mutation, redirection, or
indirection, including `>`, command substitution `$(...)` and backticks, `find -exec`/`-delete`,
`xargs`, and `awk`/`sed` `system(...)`, plus mutating verbs such as `rm`, `mv`, `cp`, `mkdir`,
`touch`, `chmod`, `chown`, `truncate`, `tee`, `dd`, `mount`, `sudo`, `su`, package installs,
mutating git subcommands, `sed -i`, and `crontab`.

#### Scenario: Unambiguous reads classify as read

- GIVEN commands such as `ls -la`, `cat server.mjs`, `grep -n async server.mjs`, `git log`, `git diff`, `head -5 f`, `wc -l f`
- WHEN each is classified
- THEN each MUST classify as read

#### Scenario: Mutations classify as write

- GIVEN commands such as `rm -rf x`, `echo x > f`, `sed -i s/a/b/ f`, `git commit -m x`, `chmod +x f`, `cp a b`, `touch f`, `mkdir d`, `mv a b`, `tee f`
- WHEN each is classified
- THEN each MUST classify as write

#### Scenario: Every pipe segment must be read-only

- GIVEN the chain `ls | grep x`
- WHEN it is classified
- THEN it MUST classify as read
- AND the chains `cat f | sh` and `ls | tee f` MUST classify as write

#### Scenario: Indirection classifies as write

- GIVEN `cat $(echo x)`, `` echo `id` ``, `find . -name x -delete`, `cat list | xargs cat`, and `awk 'system("ls")'`
- WHEN each is classified
- THEN each MUST classify as write

### Requirement: Read-only whitelist

The classifier SHALL maintain a read-only whitelist covering common inspection commands,
read-only git subcommands, and version checks. Only commands matching a whitelist entry MAY
classify as read without a write marker.

#### Scenario: A whitelisted read passes

- GIVEN `node --version` and `git status`
- WHEN each is classified
- THEN each MUST classify as read

#### Scenario: A non-whitelisted lead command is a write

- GIVEN `cat f | sh`
- WHEN it is classified
- THEN the `sh` segment MUST fail the whitelist and the chain MUST classify as write

### Requirement: Write gating with explicit opt-in

When a command classifies as a write and write access was not explicitly enabled, the sandbox
MUST refuse it at the policy layer, returning a denied result and creating no container. The
refusal message SHALL state the classification reason and the command.

#### Scenario: A denied write never reaches a container

- GIVEN a write-classified command and write access disabled
- WHEN the command is run in the sandbox
- THEN the result MUST be marked denied
- AND no container MUST be started

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

### Requirement: Double timeout brake and output cap

Execution SHALL enforce two independent time limits: an inner timeout inside the container that
terminates the command's process group, and a host-side backstop that kills the container by
name. The default command timeout SHALL be 30000 ms. Captured output SHALL be capped at a
configured maximum (default 8192 bytes), and a truncated result MUST mark the truncation. A
timeout MUST be detected from the exit status or termination signal rather than from stderr
wording alone.

#### Scenario: A timeout is reported as timed out

- GIVEN a command that exceeds its timeout
- WHEN the result is returned
- THEN it MUST be marked timed out
- AND its exit code MUST reflect the timeout or kill status

#### Scenario: Oversized output is truncated

- GIVEN a command whose output exceeds the maximum capture size
- WHEN the result is returned
- THEN the output MUST be cut at the maximum
- AND it MUST be marked truncated with an explicit marker

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

### Requirement: Route gate on sandbox verification

Unless verification is explicitly disabled per request, `POST /v1/agent` MUST run the sandbox
self-check before accepting work. If the probe is not ok, or if it does not prove that writes
are blocked, the network is blocked, and the host identity is invisible, the route MUST answer
`503` and MUST NOT start the agent.

#### Scenario: A broken sandbox is refused

- GIVEN the self-check does not prove the default posture
- WHEN `POST /v1/agent` is called with verification enabled
- THEN the route MUST answer `503`
- AND no agent job MUST be started

#### Scenario: Verification can be skipped explicitly

- GIVEN a request carries `verify:false`
- WHEN `POST /v1/agent` is called
- THEN the route MUST NOT run the self-check gate

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

