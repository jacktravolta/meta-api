# agent-sandbox-backend Specification

## Purpose

Define the pluggable sandbox backend contract: how the active backend is selected, the
backend-agnostic execution interface every caller uses, and the confinement, resource-limit,
timeout, installation, and persistence behavior of the `bwrap` backend. The hardening posture
that every backend must satisfy (deny-by-default classification, write gating, network
isolation, the self-check route gate) is defined by `agent-sandbox-hardening` and applies to
whichever backend is active.

## Requirements

### Requirement: Backend selection by environment

The system SHALL select the sandbox backend from the `META_SANDBOX_BACKEND` environment
variable. The default value SHALL be `bwrap`, so that a sandbox without explicit configuration
runs confined through bubblewrap and not through Docker. The only valid values SHALL be `bwrap`
and `docker`. When the variable holds any other value, the system MUST fail closed: it MUST
refuse to execute commands, MUST report a clear error naming the rejected value and the accepted
values (`bwrap`, `docker`), and MUST NOT silently fall back to any backend.

#### Scenario: Unset backend defaults to bwrap

- GIVEN `META_SANDBOX_BACKEND` is unset
- WHEN the active backend is resolved
- THEN the active backend MUST be `bwrap`

#### Scenario: Docker remains explicitly selectable

- GIVEN `META_SANDBOX_BACKEND=docker`
- WHEN the active backend is resolved
- THEN the active backend MUST be `docker`

#### Scenario: An invalid backend fails closed with a clear error

- GIVEN `META_SANDBOX_BACKEND=podman`
- WHEN a command is submitted for execution
- THEN the system MUST refuse to execute it
- AND the error MUST name the rejected value and the accepted values `bwrap` and `docker`
- AND no command MUST run under any backend

### Requirement: Backend-agnostic execution interface and result contract

The sandbox SHALL expose a single `runSandboxed(command, {allowWrite, allowNetwork, workdir,
timeoutMs})` interface for every backend. Callers MUST NOT need backend-specific arguments or
branches. The result of a run MUST expose the same contract for `bwrap` and `docker`: at
minimum `ok`, `exitCode`, `output`, `truncated`, `ms`, and `timedOut`, plus `denied` when the
policy layer refused the command. The `classify()` policy SHALL be shared across backends and
its decision for a given command MUST be identical regardless of the active backend.

#### Scenario: The same interface accepts both backends

- GIVEN a caller invoking `runSandboxed(command, {allowWrite, allowNetwork, workdir, timeoutMs})`
- WHEN the active backend is `bwrap`
- THEN the call MUST execute with no caller change
- AND the result MUST carry the documented fields

#### Scenario: Classification is identical across backends

- GIVEN a command
- WHEN it is classified under the `bwrap` backend and under the `docker` backend
- THEN both classifications MUST yield the same write/read decision and the same reason

### Requirement: bwrap directory jail with a persistent root

Under the `bwrap` backend every command SHALL run inside a user namespace whose visible
filesystem root is a jail assembled at execution time, never the host root. The jail root SHALL
be taken from `META_BWRAP_ROOT` and SHALL default to `~/sandbox` when unset. The root directory
SHALL be persistent: it MUST survive between commands and MUST be reused by subsequent commands
rather than being recreated or discarded per command. This is a deliberate semantic change from
the `docker` backend, whose container filesystem is ephemeral.

#### Scenario: The sandbox root is persistent and reused

- GIVEN the `bwrap` backend and a sandbox root that already contains a file from an earlier command
- WHEN a new command runs
- THEN the file from the earlier command MUST still be visible inside the jail
- AND the same root directory MUST be reused, not recreated

#### Scenario: State written in the jail survives across commands

- GIVEN a write-enabled command that creates a file inside the sandbox root
- WHEN a later read command inspects that path in the same root
- THEN the file created by the earlier command MUST be present
- AND the result MUST NOT be empty the way a fresh ephemeral container would be

### Requirement: Minimal read-only system binds and device mounts

The `bwrap` jail SHALL expose only the minimal read-only system paths required to execute
commands: `/usr`, `/lib`, `/lib64`, `/bin`, and a minimal `/etc`. It SHALL mount `--proc /proc`
and `--dev /dev`. It MUST NOT bind the host home directory and MUST NOT bind the full host root;
only explicitly allowlisted paths MAY be visible inside the jail.

#### Scenario: The minimal read-only system paths are present

- GIVEN the `bwrap` backend and any command that passes classification
- WHEN the jail is assembled
- THEN `/usr`, `/lib`, `/lib64`, `/bin`, and the minimal `/etc` MUST be present read-only
- AND `--proc /proc` and `--dev /dev` MUST be mounted

#### Scenario: The host home and full host root are not visible

- GIVEN the `bwrap` backend
- WHEN a probe lists the available filesystem
- THEN the host home directory MUST NOT be reachable
- AND no bind of the full host root MUST exist

### Requirement: Workspace confinement and write gating under bwrap

Under the `bwrap` backend the workspace SHALL be exposed inside the jail at `/workspace`. It
SHALL be bound read-only unless the command classifies as a write AND write access was explicitly
enabled (`allowWrite`). Only then SHALL the workspace be bound read-write. A command that
classifies as a write without explicit `allowWrite` MUST be denied by the policy layer before any
jail process is created.

#### Scenario: A read command gets a read-only workspace

- GIVEN a read-classified command under the default policy and the `bwrap` backend
- WHEN it is executed
- THEN the workspace bind MUST be read-only

#### Scenario: An enabled write gets a read-write workspace

- GIVEN a write-classified command with `allowWrite` enabled and the `bwrap` backend
- WHEN it is executed
- THEN the workspace bind MUST be read-write

#### Scenario: A denied write starts no jail process

- GIVEN a write-classified command and `allowWrite` disabled
- WHEN it is submitted to the `bwrap` backend
- THEN the result MUST be marked `denied`
- AND no jail process MUST be started

### Requirement: Network isolation via user namespace with explicit opt-in

Under the `bwrap` backend every command SHALL run with `--unshare-all`, which isolates the
network namespace as well as the other namespaces. Network egress SHALL be re-enabled ONLY when
network access was explicitly opted in (`allowNetwork`), by exposing the host network namespace
back to the jail. Without that opt-in, no network egress MUST be possible.

#### Scenario: Default bwrap run has no network egress

- GIVEN a command under default options and the `bwrap` backend
- WHEN it is executed
- THEN `--unshare-all` MUST isolate the network
- AND the command MUST NOT reach the network

#### Scenario: Opt-in network grants egress

- GIVEN a command with `allowNetwork` enabled and the `bwrap` backend
- WHEN it is executed
- THEN the jail MUST share the host network namespace
- AND network egress MUST be possible

### Requirement: Parent-death process cleanup

Every `bwrap` command SHALL run with `--die-with-parent` so the jail process tree is terminated
when the broker process that spawned it exits. No jail process MUST survive an exited parent.

#### Scenario: No jail process survives the parent

- GIVEN a long-running command in the `bwrap` jail
- WHEN the broker process exits
- THEN the jail process tree MUST be terminated
- AND no orphaned jail process MUST remain

### Requirement: Resource limits enforced through a systemd user scope

Under the `bwrap` backend memory, CPU, and PID limits SHALL be enforced by wrapping execution in
`systemd-run --user --scope`. The default envelope SHALL match the Docker defaults: `MemoryMax`
`256m`, `CPUQuota` equivalent to one CPU, and `TasksMax` `100`. The limits MUST be effective - a
command that exceeds a limit MUST be constrained or killed, not merely passed a request. If
`systemd-run` or a usable systemd user session is unavailable, the system MUST fail closed rather
than run the command without limits.

#### Scenario: Default limits are applied under bwrap

- GIVEN the `bwrap` backend and any command that passes classification
- WHEN it is executed
- THEN it MUST run inside a systemd user scope with `MemoryMax=256m`, one-CPU `CPUQuota`, and `TasksMax=100`

#### Scenario: Limits are effective, not merely requested

- GIVEN a command that exceeds the memory limit under the `bwrap` backend
- WHEN it is executed
- THEN it MUST be constrained or killed by the resource limit

#### Scenario: Missing systemd user scope fails closed

- GIVEN `systemd-run --user` or a usable systemd user session is unavailable
- WHEN a command is submitted to the `bwrap` backend
- THEN the system MUST refuse to run it
- AND it MUST NOT execute the command without resource limits

### Requirement: Equivalent double timeout brake under bwrap

Under the `bwrap` backend execution SHALL enforce two independent time limits, equivalent to the
Docker backend: an inner timeout that terminates the command's process group inside the jail, and
a host-side backstop that kills the systemd scope or jail process tree at the budget. The default
command timeout SHALL be `30000` ms. A timeout MUST be detected from the exit status or the
termination signal rather than from stderr wording alone, and the result MUST be marked
`timedOut`.

#### Scenario: An over-budget command is reported as timed out

- GIVEN a command that exceeds its timeout under the `bwrap` backend
- WHEN the result is returned
- THEN it MUST be marked `timedOut`
- AND its exit code MUST reflect the timeout or kill status

#### Scenario: The host backstop kills the scope

- GIVEN a command such as `sleep 30` under a 5 second budget and the `bwrap` backend
- WHEN the budget elapses
- THEN the host-side backstop MUST kill the scope or jail process tree
- AND the command MUST NOT keep running for its full duration

### Requirement: Confined user-prefix installations without privilege escalation

Inside the `bwrap` jail, installations SHALL run with the executing user's own permissions and
SHALL be confined to the sandbox root. Package managers SHALL be supported only through
user-prefix modes that write inside the sandbox, such as `pip --target <sandbox-path>` and
`npm --prefix <sandbox-path>`, with `HOME` pointing inside the sandbox root. `sudo`, `su`, and
privileged installers (`apt`, `apt-get`) MUST be rejected: they MUST classify as writes and MUST
NOT execute inside the jail, which has no root and no privilege escalation path.

#### Scenario: A pip install lands inside the sandbox root

- GIVEN a write-enabled command running `pip --target` under the `bwrap` backend
- WHEN it is executed
- THEN the installed files MUST land inside the sandbox root
- AND they MUST be owned by the executing user, not root

#### Scenario: An npm install lands inside the sandbox root

- GIVEN a write-enabled command running `npm --prefix` under the `bwrap` backend
- WHEN it is executed
- THEN the installed files MUST land inside the sandbox root
- AND they MUST be owned by the executing user, not root

#### Scenario: Privileged installation is rejected

- GIVEN a command invoking `sudo`, `su`, `apt`, or `apt-get`
- WHEN it is submitted to the `bwrap` backend
- THEN it MUST classify as a write and be denied without `allowWrite`
- AND it MUST NOT gain root or escalate privileges inside the jail
