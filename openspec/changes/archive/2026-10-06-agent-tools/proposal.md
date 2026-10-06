# Proposal: Agent Tools Execution

> **Retrospective record.** This change documents work that is already implemented and
> verified on branch `feat/agent-tools` (10 tasks, ~25 commits, 38 passing tests). It is
> registered in SDD after the fact to capture intent, scope and known limits. The
> implementation is the source of truth; this proposal must stay honest about what shipped,
> what is verified, and what was deliberately left out.

## Intent

`meta-api` exposed Meta AI as an OpenAI-compatible chat API but could not act on the world:
the model could only produce text. This change turns the broker into an **agent runtime**:
`POST /v1/agent` accepts a task in natural language, Meta AI emits shell commands, an
ephemeral Docker sandbox executes them, and the output is fed back to Meta until the model
answers in plain text. The loop is returned as `agent:{ok,steps,transcript}`.

The protocol insight (Meta emits shell commands when the prompt frames the task as commands
rather than tools) was already proven by one live step. This change makes the loop *trustworthy
enough to actually use*: security posture that matches its own comments, recovery that
preserves the agent path, budgets that allow multi-step missions, input validation that cannot
mount arbitrary host paths, regression tests, and user documentation.

## Scope

### In Scope

- **Tool loop over shell**: natural-language task → shell command protocol → sandbox execution
  → output feedback → final plain-text answer, gated by `maxSteps` and a wall-clock budget.
- **Job identity persistence**: queued agent jobs survive a broker restart with their
  `{agent, maxSteps, budgetMs, allowWrite, allowNetwork, workdir}` identity, so they replay as
  agent jobs and never as raw chat.
- **Failure recovery**: a mid-loop Meta error preserves and delivers the partial transcript
  instead of dropping the result (`agent.ok:false`, `reason:"meta-error:<msg>"`).
- **Budget / patience**: `budgetMs` request field clamped to 30s..1h plus
  `META_AGENT_BUDGET_MS` default (900000); agent jobs skip the pre-pump context rotation.
- **Input validation**: `workdir` must `realpath` inside `META_SANDBOX_WORKDIR_ROOTS`;
  `maxSteps` clamped 1..32; `task` capped at 8000 chars.
- **Hardening**: self-check probes the default (write-denied) policy and gates the route with
  a 503; deny-by-default command classifier; 50000-char command cap;
  `meta-sandbox:1` image with `php-cli` and `curl` baked in.
- **Multimodal input**: `images[]` (screenshots) accepted on `POST /v1/agent` and attached on
  the first turn.
- **Test foundation**: native `node:test` suite (zero new dependencies) pinning parser,
  classifier, loop, and sandbox self-check.
- **Documentation**: README endpoint list and the full `/v1/agent` contract.

### Out of Scope

- **API authentication**: absent by design; localhost binding remains the only control.
- **Native function calling**: Meta AI does not offer it, so the shell-command protocol is the
  only path; no tool-call schema support is planned here.
- **Guarantees around Meta's UI**: completion detection depends on scraping the Meta web UI and
  is inherently fragile; this change improves it but does not and cannot make it contractual.
- **System runner / classifier rewrite**: the read-only whitelist remains textual. The residual
  indirection vector is contained by the `:ro` mount and no network, not eliminated.
- **Runtime state hygiene**: untracking `systemd/medicion.conf` and the `server.mjs.bak-*`
  leftover remain follow-up, not part of this change.
- **Multi-user / remote hosting**: single-operator local deployment only.

## Capabilities

> `openspec/specs/` is empty today; every capability below is new. Full specs are written
> during the spec phase at `openspec/changes/agent-tools/specs/<name>/spec.md`.

### New Capabilities

- `agent-tool-execution`: the command-loop contract — task intake, shell-command protocol
  parsing, step iteration, completion detection, transcript shape, and final answer.
- `agent-sandbox-hardening`: the execution isolation contract — Docker posture
  (`--network none`, `--read-only`, `--cap-drop=ALL`), deny-by-default command classifier,
  self-check policy gate, command/output caps, and the `meta-sandbox:1` image contract.
- `agent-job-lifecycle`: the persistence and patience contract — agent identity across restarts,
  budget clamping, non-rotation of agent jobs, and partial-transcript delivery on failure.
- `agent-input-validation`: the request-validation contract — `workdir` root confinement,
  `maxSteps` clamp, `task` length cap, and write/network opt-in acknowledgment.
- `agent-multimodal-input`: the multimodal contract — accepting `images[]` on the agent route
  and attaching captures on the first turn.

### Modified Capabilities

- None — no pre-existing specs exist to modify.

## Approach

Meta AI is framed to answer with a shell command in a code fence tagged `sh`; untagged fences
are accepted and other languages (e.g. Python) are rejected. Each command is classified
deny-by-default against a per-segment read-only whitelist, then executed in an ephemeral
Docker container with no network, a read-only root, a mounted workspace, and a double timeout
brake (inner `timeout` plus host-side `docker kill` by container name). The captured output is
fed back as the next turn; the loop repeats until the model replies in plain text or a budget
(`maxSteps` or `budgetMs`) is exhausted. The job result is delivered through the existing
`/v1/jobs/{job_id}` poll endpoint as `agent:{ok,reason,steps,transcript}`.

Security posture is asserted at request time: a mandatory `verify` self-check probes the
default write-denied policy and the route returns `503` if the sandbox does not prove it.
`allowWrite` requires an explicit `allowWriteAck:true`; `allowNetwork` is a separate opt-in.
The proposal references the ODD task document (`odd/tasks/agent-tools.md`) and the git history
of `feat/agent-tools` as the implementation record.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `server.mjs` | Modified | `POST /v1/agent` route, `submitAgent`, agent pump branch, poll passthrough, input validation, self-check 503 gate, image attach, input persistence |
| `agent/loop.js` | Modified | `runAgentLoop` budget, transcript preservation on Meta failure, `maxSteps` |
| `agent/sandbox.js` | Modified | `classify()` deny-by-default hardening, self-check policy probe, double timeout, command cap |
| `agent/tools.js` | Modified | Parser: fence tags, `SHELL_TAGS` filter, last-block-wins, marker stripping, command length cap |
| `agent/Dockerfile.sandbox` | Modified | Bake `php-cli` and `curl` into `meta-sandbox:1` |
| `agent/tools.test.js` | New | Parser regression suite |
| `agent/sandbox.test.js` | New | Classifier + self-check regression suite |
| `agent/loop.test.js` | New | Loop behavior suite with a stubbed `ask()` |
| `README.md` | Modified | Endpoint list and `/v1/agent` contract |
| `.gitignore` | Modified | Fix corrupted `*.logagent/` line |
| `odd/tasks/agent-tools.md` | New | ODD feature/task record (T1–T10) |
| `systemd/meta-api.service.d/paciencia-agente.conf` | New | Runtime budget/patience configuration for the agent service |
| `systemd/meta-api.service.d/medicion.conf` | Removed | Measurement-transient state untracked |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Meta web UI scraping breaks completion detection at any time | High | Treat Meta behavior as untrusted; keep the budget as a hard stop and preserve partial transcripts instead of corrupting results |
| Textual read-only whitelist can be bypassed via indirection (`$(...)`, backticks, `find -exec`, `awk system()`) | Med | Classifier denies substitution/`-exec`/`-delete`/`xargs`/`system()` shapes; residual risk contained by `:ro` mount + `--network none`; documented as a known residual vector |
| `workdir` mount could expose arbitrary host paths | Low | `realpath` confinement against `META_SANDBOX_WORKDIR_ROOTS`; request refused with 400 |
| Live verification is gated on the running measurement round | Med | Unit + docker-only smoke verified now; live single/multi-step already verified on `job-39368622`; do not restart or POST to the live broker during measurement |
| Docker daemon / image unavailable in a target environment | Low | Self-check returns 503 by design; README documents the image build command |
| Long multi-step missions exhaust the wall-clock budget | Med | `budgetMs` clamped 30s..1h with a 900s default; budget exhaustion returns `agent.ok:false` with the transcript |

## Rollback Plan

The change lives entirely on branch `feat/agent-tools` and is not merged to `main`. To roll
back:

1. **Code**: `git checkout main` (or revert the `feat/agent-tools` commit range
   `db4a1e8..40558a2`). All agent modules, tests, README changes and the ODD task doc are
   contained in that range; `server.mjs` is the only pre-existing file with substantial
   changes and reverts cleanly.
2. **Runtime**: the running broker executes the branch checkout. Because the live broker is
   serving measurement round 3, do **not** restart or reload the service; roll back on disk
   only, and only after the measurement round ends.
3. **Tests/docs**: deleting the three `agent/*.test.js` files and reverting `README.md`
   returns the repo to the `main` baseline with no runtime effect.
4. **No data migration** is involved: `pending-jobs.json` / `state.json` are gitignored
   runtime state. In-flight agent jobs are lost on rollback, which is acceptable for a
   single-operator local deployment.

## Dependencies

- Docker daemon with the `meta-sandbox:1` image built from `agent/Dockerfile.sandbox`.
- A running Meta AI broker reachable over CDP (the "model" and the browser worker).
- Node.js 22 native `node:test` (no npm packages added).
- No external services or new network dependencies; agent execution itself is offline by default.

## Success Criteria

- [x] `agent.{ok,steps,transcript}` is returned by `POST /v1/agent` after a completed mission.
- [x] A multi-step live agent task completes within budget with adaptation to command failure
      (verified live, `job-39368622`: 7 steps, ~150s of 900s).
- [x] Self-check writes nothing to the host and the route is gated by `writeBlocked`.
- [x] A restarted agent job resumes as an agent job (identity persisted end-to-end).
- [x] Agent jobs never trigger context rotation.
- [x] `workdir` outside the configured roots is refused; `maxSteps`, `task`, and command
      lengths are clamped/capped.
- [x] `node --test 'agent/*.test.js'` passes (38/38 at the documented baseline).
- [x] README documents the endpoint list and the full `/v1/agent` contract.
