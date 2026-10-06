# Agent Input Validation Specification

## Purpose

Define the request-validation contract of `POST /v1/agent`: required task intake and length
cap, workspace path confinement, step and timeout clamping, write opt-in acknowledgment, and
acceptance of multimodal screenshot inputs.

## Requirements

### Requirement: Task is required

The route MUST reject a request that carries no task with a `400`. The task SHALL be taken from
`task`, or from the first message's content when `task` is absent, trimmed.

#### Scenario: A missing task is refused

- GIVEN a request with no `task` and no usable message content
- WHEN `POST /v1/agent` is called
- THEN the route MUST answer `400`

### Requirement: Task length cap

The route MUST reject a task longer than 8000 characters with a `400` that states the actual
length and the maximum.

#### Scenario: An oversized task is refused

- GIVEN a task of 8001 characters
- WHEN `POST /v1/agent` is called
- THEN the route MUST answer `400`
- AND the message MUST state the length and the 8000-character maximum

#### Scenario: A task at the cap is accepted

- GIVEN a task of exactly 8000 characters
- WHEN `POST /v1/agent` is called
- THEN the route MUST accept the request

### Requirement: Workspace path confinement

A requested `workdir` MUST resolve through `realpath` and MUST be equal to, or nested under,
one of the configured roots in `META_SANDBOX_WORKDIR_ROOTS` (colon-separated, default
`/home/test/test`). A path that does not resolve, or resolves outside every root, MUST be
refused with a `400`. The default workspace (`META_SANDBOX_WORKDIR`) MUST pass through the same
check, and the stored job MUST hold the resolved path.

#### Scenario: An out-of-roots path is refused

- GIVEN a `workdir` that resolves outside every configured root
- WHEN `POST /v1/agent` is called
- THEN the route MUST answer `400`
- AND no agent job MUST be started

#### Scenario: An unresolvable path is refused

- GIVEN a `workdir` that does not exist
- WHEN `POST /v1/agent` is called
- THEN the route MUST answer `400`

#### Scenario: A symlink escape is refused

- GIVEN a path inside a root that is a symlink pointing outside the roots
- WHEN the workdir is validated
- THEN the realpath MUST fall outside the roots and the request MUST be refused

#### Scenario: A confined path is accepted

- GIVEN a `workdir` that resolves inside a configured root
- WHEN `POST /v1/agent` is called
- THEN the job MUST store the resolved path and be accepted

### Requirement: Step budget clamping

`maxSteps` SHALL be clamped to the range 1..32, rounded to a whole number, defaulting to 8 when
absent or non-numeric. The clamp MUST be applied before the job is stored, so every persisted
job carries a bounded step budget.

#### Scenario: Out-of-range step budgets are clamped

- GIVEN requests with `maxSteps` 0 and 99
- WHEN each is stored
- THEN the stored values MUST be 1 and 32 respectively

#### Scenario: An absent step budget defaults

- GIVEN a request with no `maxSteps`
- WHEN the job is stored
- THEN its `maxSteps` MUST be 8

### Requirement: Per-command sandbox timeout clamping

The per-command sandbox timeout SHALL be clamped to the range 5000..600000 ms, rounded to a
whole number, defaulting to 30000 ms when absent or invalid.

#### Scenario: An out-of-range sandbox timeout is clamped

- GIVEN requests with `sandboxTimeoutMs` 100 and 99999999
- WHEN each is stored
- THEN the stored values MUST be 5000 and 600000 respectively

### Requirement: Write access requires explicit acknowledgment

When a request enables write access without the explicit acknowledgment, the route MUST answer
`400` and MUST NOT start the job. Write access SHALL be honored only when the request carries
both `allowWrite:true` and `allowWriteAck:true`.

#### Scenario: Write without acknowledgment is refused

- GIVEN a request with `allowWrite:true` and no `allowWriteAck`
- WHEN `POST /v1/agent` is called
- THEN the route MUST answer `400`
- AND no agent job MUST be started

#### Scenario: Accepted write opt-in proceeds

- GIVEN a request with `allowWrite:true` and `allowWriteAck:true`
- WHEN `POST /v1/agent` is called
- THEN the job MUST be accepted with write access enabled

### Requirement: Screenshot input acceptance

The route SHALL accept an `images` array and MUST keep only entries that are strings beginning
with `data:image/`. Other entries MUST be discarded, and the accepted list MUST be capped at
four images. The accepted images SHALL be stored with the job.

#### Scenario: Non-image entries are discarded

- GIVEN an `images` array containing a `data:image/png;base64,...` string and a plain URL
- WHEN the job is stored
- THEN only the data-URL image MUST be kept

#### Scenario: At most four images are kept

- GIVEN an `images` array of more than four data-URL images
- WHEN the job is stored
- THEN at most four MUST be kept
