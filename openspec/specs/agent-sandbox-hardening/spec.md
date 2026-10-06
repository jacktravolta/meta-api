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

### Requirement: Docker execution posture

Every executed command MUST run in an ephemeral container with a read-only root, all
capabilities dropped, no new privileges, capped memory, CPUs and PIDs, `HOME` redirected to a
writable temp filesystem, and the workspace mounted at `/workspace`. The default resource
envelope SHALL be memory 256m, 1 CPU, PID limit 100, image `meta-sandbox:1`, and shell `/bin/sh`.

#### Scenario: The container runs with the hardened flags

- GIVEN any command that passes classification
- WHEN it is executed
- THEN the container MUST start with `--rm`, `--read-only`, `--cap-drop=ALL`, and `--security-opt=no-new-privileges`
- AND it MUST be constrained by the memory, CPU and PID limits

### Requirement: Read-only workspace unless writes are enabled

The workspace SHALL be mounted read-only. It SHALL be mounted read-write only when the command
classifies as a write AND write access was explicitly enabled.

#### Scenario: A read command gets a read-only mount

- GIVEN a read-classified command under the default policy
- WHEN it is executed
- THEN the workspace mount MUST carry the `:ro` option

#### Scenario: An enabled write drops `:ro`

- GIVEN a write-classified command with write access enabled
- WHEN it is executed
- THEN the workspace mount MUST be read-write

### Requirement: Network isolation by default

The container SHALL run with `--network none` by default. Network egress SHALL be enabled only
when network access was explicitly opted in, in which case the container SHALL use `bridge`.

#### Scenario: Default network is disabled

- GIVEN a command under default options
- WHEN the container starts
- THEN its network MUST be `none`

#### Scenario: Opt-in network uses bridge

- GIVEN a command with network access enabled
- WHEN the container starts
- THEN its network MUST be `bridge`

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

### Requirement: Self-check proves the default posture

The sandbox self-check SHALL probe the default, write-denied policy. The write probe MUST
classify as a write and MUST be refused by the policy layer before any container exists, so
`writeBlocked:true` means the command was denied by policy and never executed. A read-classified
filesystem probe MUST execute and prove the workspace is mounted and readable. A trusted,
statically authored probe MUST verify that network access is blocked by default and that the
container host identity is invisible. The self-check SHALL report `ok` only when all four hold.

#### Scenario: The write probe is denied by policy, not executed

- GIVEN the default policy
- WHEN the self-check write probe runs
- THEN `writeBlocked` MUST be true
- AND no probe artifact MUST be created in the host workspace

#### Scenario: The full default posture verifies

- GIVEN a reachable Docker daemon
- WHEN the self-check runs
- THEN `writeBlocked`, `fsRead`, `networkBlocked` and `hostHomeInvisible` MUST all be true
- AND `ok` MUST be true

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
bake in the tooling the agent is expected to use (`php-cli` and `curl`) so common commands do
not require network installs at run time.

#### Scenario: The default image carries the expected tooling

- GIVEN the default sandbox image
- WHEN a command invokes the baked-in tools
- THEN they MUST be available without installing anything
