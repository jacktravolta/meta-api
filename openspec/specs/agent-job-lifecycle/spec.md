# Agent Job Lifecycle Specification

## Purpose

Define the persistence, recovery and patience contract for agent jobs: their identity survives
a broker restart, they replay through the agent path and never as raw chat, mid-loop failures
deliver an honest partial result, agent jobs are exempt from context rotation, and the
wall-clock budget is validated, clamped and enforced.

## Requirements

### Requirement: Agent identity persists across restart

Queued or running agent jobs SHALL be mirrored to durable storage together with their agent
identity: the `agent` flag, `maxSteps`, `budgetMs`, `sandboxTimeoutMs`, `allowWrite`,
`allowNetwork`, and `workdir`. On boot, persisted pending jobs within the recovery window SHALL
be re-queued with that same identity.

#### Scenario: A queued agent job survives a restart

- GIVEN a queued agent job with `maxSteps`, `budgetMs`, write/network flags and a `workdir`
- WHEN the broker restarts and recovers pending jobs
- THEN the recovered job MUST carry the agent flag and all of its identity fields

### Requirement: Recovered agent jobs replay as agent jobs

A recovered agent job MUST flow through the agent branch (loop plus sandbox) exactly as if it
had just been submitted. It MUST NOT be replayed as a raw chat completion.

#### Scenario: Recovery routes through the loop, not chat

- GIVEN a recovered job carrying the agent flag
- WHEN the worker pumps that job
- THEN it MUST drive the agent loop with the job's task, step budget and sandbox options
- AND it MUST NOT send the raw task to Meta as a plain completion

### Requirement: Recovery window bounds replay

Persisted jobs older than the recovery window (default 30 minutes, configurable through
`META_RECOVERY_MAX_AGE_MS`) SHALL be dropped on recovery rather than replayed.

#### Scenario: A stale pending job is dropped

- GIVEN a persisted pending job whose creation time is older than the recovery window
- WHEN the broker recovers pending jobs
- THEN that job MUST NOT be re-queued

### Requirement: Budget validation and clamping

A per-request wall-clock budget SHALL be clamped to the range 30000..3600000 ms, rounded to
whole milliseconds. An absent or invalid value SHALL fall back to `META_AGENT_BUDGET_MS`, whose
default is 900000 ms. The validated budget SHALL be stored with the job so a recovered job
keeps it.

#### Scenario: An out-of-range budget is clamped

- GIVEN a request budget of 1000 ms and another of 99999999 ms
- WHEN each is validated
- THEN they MUST become 30000 and 3600000 respectively

#### Scenario: An absent budget uses the environment default

- GIVEN no request budget is provided
- WHEN the budget is resolved
- THEN it MUST come from `META_AGENT_BUDGET_MS`
- AND with that variable unset it MUST be 900000

### Requirement: Budget enforcement across the mission

The loop SHALL enforce the wall-clock budget between steps so a long mission stops within
budget. When the budget is exhausted, the job SHALL complete with a non-final result rather
than run indefinitely.

#### Scenario: An exhausted budget ends the mission honestly

- GIVEN an agent job whose steps outlast its budget
- WHEN the budget is exceeded between steps
- THEN the loop MUST stop and the job MUST record a `budget` reason

### Requirement: No context rotation for agent jobs

Agent jobs MUST skip the pre-pump context rotation entirely. The loop drives the worker's
thread turn by turn, so the mission transcript is the context; rotating first would spend a
Meta turn on a summary the loop never reads and delete the thread mid-mission.

#### Scenario: An agent job does not rotate

- GIVEN a worker whose thread would normally trigger rotation
- WHEN an agent job is pumped
- THEN no context-usage evaluation and no thread rotation MUST occur for that job
- AND a chat job MUST still rotate as before

### Requirement: Partial transcript delivered on mid-loop failure

When the model request throws mid-mission, the job MUST complete rather than error, carrying an
`agent` result with `ok:false`, reason `meta-error:<message>`, the completed step count, and the
partial transcript. The job's readable content SHALL summarize the failure and reference the
partial transcript.

#### Scenario: A Meta error yields an honest partial result

- GIVEN an agent job where Meta fails after one completed tool step
- WHEN the job completes
- THEN its `agent.ok` MUST be false with a `meta-error:` reason
- AND its `agent.transcript` MUST include the completed turns
- AND its content MUST be a readable failure summary, not an empty string

### Requirement: Honest failure summaries for non-final outcomes

When a loop resolves without a final answer, the job SHALL expose a non-empty human-readable
summary for each reason (`max-steps`, `budget`, `meta-error`, or any other reason) while the
full evidence remains available in the agent result.

#### Scenario: max-steps produces a readable summary

- GIVEN a loop that ends because the step limit was reached
- WHEN the job result is built
- THEN the content MUST state that the step limit was reached
- AND it MUST NOT be empty

### Requirement: Poll response exposes the agent result

The poll endpoint SHALL return the agent result (ok, reason, steps, transcript) when present.
Per-turn transcript `text` and `output` SHALL be capped so a long mission cannot return
unbounded payloads.

#### Scenario: The poll response carries the agent block

- GIVEN a completed agent job
- WHEN `GET /v1/jobs/{job_id}` is called
- THEN the response MUST include the `agent` object with `ok`, `reason`, `steps` and `transcript`
- AND each transcript turn's `text` and `output` MUST be bounded in length
