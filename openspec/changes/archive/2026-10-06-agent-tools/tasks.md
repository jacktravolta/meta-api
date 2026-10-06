# Tasks: Agent Tools Execution

> **Retrospective record.** Every task below is already implemented, verified and committed on
> branch `feat/agent-tools`. Boxes are checked with the commit and test that produced each
> deliverable; this file is not a plan to execute — it is the audited task breakdown of work
> that shipped. Line estimates and the review forecast are recorded for completeness, not as a
> pending gate.
>
> Sources: `proposal.md`, `specs/*/spec.md`, `design.md`, `odd/tasks/agent-tools.md`, and
> `git log --oneline main..HEAD` (25 commits, `db4a1e8..40558a2`).

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~999 (`916 insertions + 83 deletions` across 14 tracked files) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Already delivered as ~24 work-unit commits on `feat/agent-tools` (feature branch chain, not merged to `main`) |
| Delivery strategy | exception-ok (retrospective; oversized change accepted and already committed) |
| Chain strategy | feature-branch-chain (all slices land on `feat/agent-tools`; `main` untouched) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

The size guard is satisfied by history, not by a future plan: the change was committed as small,
single-purpose work units (each with the tests that pin its behavior) on one feature branch. It is
above the 400-line budget as a whole, so `Chained PRs recommended` is `Yes`; `Decision needed
before apply` is `No` because nothing remains to approve before apply.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| U1 | Sandbox security posture (selfCheck policy probe, classifier hardening, sandbox image tooling) | slice 1 | `node --test 'agent/sandbox.test.js'` | `docker build -f agent/Dockerfile.sandbox -t meta-sandbox:1 .` then direct `selfCheck()` import | `agent/sandbox.js`, `agent/Dockerfile.sandbox`, `agent/sandbox.test.js`, `server.mjs` gate block |
| U2 | Route input validation and protocol caps | slice 2 | `node --test 'agent/tools.test.js'` | `POST /v1/agent` with out-of-roots `workdir` / oversized `task` (expect 400) | `server.mjs` validation block, `agent/tools.js` cap |
| U3 | Agent job lifecycle and patience budgets | slice 3 | `node --test 'agent/loop.test.js'` | restart broker with a queued agent job in `pending-jobs.json` (read-only fixture) | `server.mjs` persist/pump, `agent/loop.js`, `systemd/meta-api.service.d/paciencia-agente.conf` |
| U4 | Meta loop reliability (refusal retry, partial transcript) | slice 4 | `node --test 'agent/loop.test.js'` | stub `ask()` throw / refusal sequence | `agent/loop.js`, `server.mjs` failure summary |
| U5 | Completion semaphore over the Meta UI | slice 5 | N/A (broker DOM logic, no unit target) | live single/multi-step via `POST /v1/agent` watching journal `agent` events | `server.mjs` askMeta completion block |
| U6 | Multimodal screenshot input | slice 6 | N/A (route-level, covered by API contract) | `POST /v1/agent` with `images[]`; inspect first-turn attach | `server.mjs` images handling, `agent/loop.js` first-turn attach |
| U7 | Test foundation and documentation | slice 7 | `node --test 'agent/*.test.js'` (38 tests) | N/A — pure node:test, zero services | `agent/*.test.js`, `README.md`, `.gitignore` |
| U8 | Live single/multi-step verification | slice 8 | N/A — manual live proof | `POST /v1/agent` on the live broker, `job-39368622` | none (evidence only; recorded in `odd/tasks/agent-tools.md` via `beae9c8`) |

## Phase 1 — Sandbox Security Foundation

- [x] 1.1 **Probe the default (write-denied) policy in `selfCheck` and gate the route on it.** Split
  the probe so the filesystem/network sub-probes classify as reads, assert the write attempt is
  denied by the policy layer (`writeBlocked:true`, no container created), add `writeBlocked` to the
  route's gate so a failed posture returns `503` and starts no job, and remove the leaked host
  artifact `/home/test/test/.sandbox-probe`.
  Files: `agent/sandbox.js`, `server.mjs`, `agent/sandbox.test.js`
  Evidence: `db4a1e8` (`fix(agent): probe the default write policy in selfCheck`); 29 added test
  lines; spec `agent-sandbox-hardening` — "The write probe is denied by policy, not executed" and
  "A broken sandbox is refused" (503).

- [x] 1.2 **Harden the classifier against the residual indirection vector.** Deny command
  substitution (`$(...)`, backticks), `find -exec`/`-delete`, `xargs`, and `awk`/`sed system(...)`
  shapes in read-only mode, so a whole chain is poisoned as a write.
  Files: `agent/sandbox.js`, `agent/sandbox.test.js`
  Evidence: `26fa113` (`fix(agent): validate /v1/agent inputs and close the indirection vector`);
  threat-matrix indirection row; spec `agent-sandbox-hardening` — "Indirection classifies as write".

- [x] 1.3 **Pin classifier threat-matrix cases as regression tests.** Cover read pass, write deny,
  per-segment pipe enforcement (`ls | grep x` read; `cat f | sh`, `ls | tee f` write),
  non-whitelisted lead, and mutating-git denial.
  Files: `agent/sandbox.test.js`
  Evidence: `26fa113`, `311d45c`; 12 sandbox tests in the 38-test baseline; design Threat Matrix
  (documentation-like paths, git selection, commit state, push state, indirection).

- [x] 1.4 **Bake `php-cli` and `curl` into `meta-sandbox:1`.** Runtime `apt` is impossible by design
  (read-only root, no network), so web-dev tooling must be built into the image.
  Files: `agent/Dockerfile.sandbox`
  Evidence: `de04c19` (`feat(agent): bake php-cli and curl into the sandbox image`); spec
  `agent-sandbox-hardening` — "The default image carries the expected tooling".

## Phase 2 — Input Validation and Protocol Caps

- [x] 2.1 **Confine `workdir` with `realpath` against `META_SANDBOX_WORKDIR_ROOTS`.** The requested
  path must resolve inside a configured root (colon-separated, default `/home/test/test`); the
  default workspace passes the same check; a symlink escape resolves outside and is refused `400`.
  Files: `server.mjs`
  Evidence: `26fa113`; spec `agent-input-validation` — out-of-roots, unresolvable, symlink escape,
  and confined-path scenarios.

- [x] 2.2 **Clamp `maxSteps` (1..32, default 8) and cap `task` at 8000 chars, before the job is
  stored.** `task` is taken from `task` or the first message content, trimmed; oversized tasks get
  a `400` stating actual length and the 8000 maximum.
  Files: `server.mjs`
  Evidence: `26fa113`; spec `agent-input-validation` — step clamping and task length cap scenarios.

- [x] 2.3 **Require explicit write acknowledgment.** Honor `allowWrite` only with
  `allowWriteAck:true`; otherwise answer `400` and start no job.
  Files: `server.mjs`
  Evidence: `26fa113`; spec `agent-input-validation` — write-without-ack refused, accepted opt-in
  proceeds.

- [x] 2.4 **Raise the per-command length cap for whole-file writes.** First 4000 → 20000
  (`META_TOOL_MAX_COMMAND`, floor 4000) after chunked base64 corrupted a generated file live, then
  20000 → 50000 after a ~19.6KB base64 landing page grazed the cap.
  Files: `agent/tools.js`, `agent/tools.test.js`, `server.mjs`
  Evidence: `152400e` (`raise the per-command cap to fit whole-file writes`), `026fbc2` (`cap the
  command at 50000 chars`); spec `agent-tool-execution` — oversized rejected, exact-cap accepted.

- [x] 2.5 **Add per-request `sandboxTimeoutMs` (clamped 5000..600000, default 30000).** Separates
  the per-command container timeout from the per-job wall clock.
  Files: `server.mjs`
  Evidence: `5eef853` (`feat(agent): per-request sandbox command timeout`); spec
  `agent-input-validation` — per-command sandbox timeout clamping.

## Phase 3 — Agent Job Lifecycle and Patience

- [x] 3.1 **Persist agent identity across restarts.** `persistPending`/`loadPending` carry
  `{agent, maxSteps, budgetMs, sandboxTimeoutMs, allowWrite, allowNetwork, workdir}` (and `images`)
  so a recovered job replays through the agent branch, never as raw chat.
  Files: `server.mjs`
  Evidence: `d2f6977` (`fix: persist agent identity across restarts`); spec `agent-job-lifecycle` —
  identity survives restart and recovery routes through the loop.

- [x] 3.2 **Skip pre-pump context rotation for agent jobs.** Rotation is computed and discarded for
  `j.agent`, so the loop never spends a Meta turn on a summary it will not read nor delete the
  thread mid-mission; chat jobs still rotate.
  Files: `server.mjs`
  Evidence: `d2a42cd` (`fix: skip context rotation for agent jobs`); spec `agent-job-lifecycle` —
  "An agent job does not rotate".

- [x] 3.3 **Make the wall clock configurable.** `budgetMs` request field clamped 30000..3600000,
  falling back to `META_AGENT_BUDGET_MS` (default 900000); the validated value is stored with the
  job and used by `runAgentLoop`.
  Files: `agent/loop.js`, `server.mjs`, `agent/loop.test.js`
  Evidence: `5cc2544` (`feat(agent): configurable per-job wall-clock budget`); spec
  `agent-job-lifecycle` — budget clamping and environment default.

- [x] 3.4 **Preserve the partial transcript on a mid-loop Meta failure.** `runAgentLoop` catches
  `ask()` throws and resolves `{ok:false, reason:"meta-error:<msg>", steps, transcript}`; `pump`
  writes a readable failure summary into `j.content` and sets `j.agentResult` instead of erroring
  the job blind.
  Files: `agent/loop.js`, `server.mjs`, `agent/loop.test.js`
  Evidence: `74a3864` (`fix(agent): preserve the transcript when Meta fails mid-loop`); spec
  `agent-job-lifecycle` — "A Meta error yields an honest partial result".

- [x] 3.5 **Prove the patience envelope against long Meta turns.** Add the runtime overrides so a
  long status line cannot be mistaken for a finished turn: `META_JOB_TIMEOUT_MS=600000` and
  `META_MAX_POLLS=900`, and never finalize a turn by idle while waiting for the end-of-message
  icons.
  Files: `systemd/meta-api.service.d/paciencia-agente.conf`, `server.mjs`
  Evidence: `277272f` (`fix: never finalize a turn by idle while waiting for the end icons`).

## Phase 4 — Meta Loop Reliability

- [x] 4.1 **Retry generic Meta refusals instead of reporting a false success.** Recognize refusal
  prose and re-anchor the task up to a bounded number of attempts (`META_AGENT_REFUSAL_RETRIES`,
  default 3, clamped 0..6); persistent refusals resolve `ok:false` with reason `meta-refusal`.
  Files: `agent/loop.js`, `agent/loop.test.js`
  Evidence: `dfdab61` (`fix(agent): retry generic Meta refusals instead of reporting false
  success`); spec `agent-tool-execution` — transient refusal retried, persistent refusals fail
  honestly.

## Phase 5 — Completion Semaphore over the Meta UI

- [x] 5.1 **Use the end-of-message action bar as the only completion semaphore.** Replace the dead
  `.msg-copy` selector and the stop-control-vanishing heuristic with the aria-labeled action bar
  (`button[aria-label="Copiar respuesta"]`, `Compartir`, `Me gusta esta respuesta`).
  Files: `server.mjs`
  Evidence: `356ab54` (`fix: end-of-message icons are the only completion semaphore`), `5469d01`
  (`fix: the end-of-message action bar is the completion semaphore`); design Decision on
  completion.

- [x] 5.2 **Make a status line unable to finalize a turn.** Treat "stop gone" as the real signal
  and guard additional status verbs (`dividiendo|partiendo|completando` added to the existing
  Spanish status prefix set) so progress text is never returned as the final answer.
  Files: `server.mjs`
  Evidence: `16e4933` (`fix: stop-gone is the real completion signal; status lines never
  finalize`), `026fbc2` (`guard more status verbs`).

- [x] 5.3 **Add a multi-message grace window after the action bar.** Seeing the bar starts
  `COPY_GRACE_MS` (default 12000ms); if Meta starts generating a follow-up message the close is
  cancelled and reading continues.
  Files: `server.mjs`
  Evidence: `9f8a505` (`fix: grace window after the action bar (multi-message answers)`); design
  Decision — "Completion is the end-of-message action bar plus a multi-message grace window".

## Phase 6 — Multimodal Input

- [x] 6.1 **Accept `images[]` on `POST /v1/agent` and attach them on the first turn only.** Keep
  only strings beginning with `data:image/`, cap at four, store them with the job, attach on the
  first `ask()`; later steps rely on the Meta thread retaining them.
  Files: `server.mjs`, `agent/loop.js`
  Evidence: `b186bf7` (`feat(agent): accept screenshot images on POST /v1/agent`); specs
  `agent-input-validation` (screenshot acceptance) and `agent-multimodal-input` (first-turn attach,
  later steps send none, persistence/recovery replays images).

## Phase 7 — Test Foundation and Documentation

- [x] 7.1 **Create the native `node:test` suite (zero new dependencies).** Parser cases
  (tagged/untagged fences, foreign tag ignored, foreign fence cannot pre-empt, `Shell sh` prefix,
  empty block error, oversized vs exact-cap, last-block-wins, marker stripping, JSON shape,
  `formatResult`), classifier cases (read pass, write deny, per-segment pipes, substitution deny),
  loop cases with stubbed `ask`/injected `exec` (multi-step success, parser-rejection correction,
  `maxSteps`, budget, `meta-error` preserves transcript, refusal retry), and the docker-conditional
  `selfCheck` posture test.
  Files: `agent/tools.test.js`, `agent/sandbox.test.js`, `agent/loop.test.js`
  Evidence: `311d45c` (`test(agent): node:test foundation for parser, classifier, loop, selfCheck`);
  `node --test 'agent/*.test.js'` → 38 pass / 0 fail (15 parser + 12 sandbox + 11 loop).

- [x] 7.2 **Document the endpoint list and the full `/v1/agent` contract in `README.md`, and fix
  the corrupted `.gitignore` line.** Add the agent env vars and the request/response contract.
  Files: `README.md`, `.gitignore`
  Evidence: `31de051` (`docs: document POST /v1/agent and fix the .gitignore log line`); spec
  success criteria — README documents the endpoint and contract.

- [x] 7.3 **Track the ODD feature/task record and untrack runtime/measurement state.** Add
  `odd/tasks/agent-tools.md` (T1–T10) and untrack `pending-jobs.json` and
  `systemd/meta-api.service.d/medicion.conf` (measurement-transient).
  Files: `odd/tasks/agent-tools.md`, `.gitignore`, `pending-jobs.json`,
  `systemd/meta-api.service.d/medicion.conf`
  Evidence: `d1297a2` (`chore: untrack runtime state and measurement config, track the ODD feature
  doc`). An added `AGENTE.md` guide was reverted because it belonged to `demo-landin`
  (`4e7acae`, `40558a2`), leaving README as the single documentation source.

## Phase 8 — Live Verification

- [x] 8.1 **Verify a single-step mission live, then a multi-step mission with adaptation to command
  failure.** The multi-step proof (`job-39368622`) solved a line-count task in 7 steps, adapting
  from a failed `wc` to `find` and answering `2067 lineas`, with optional-tag fences, a complete
  transcript, and ~150s of the 900s budget consumed.
  Evidence: live run on `job-39368622` (2026-10-05); recorded in `odd/tasks/agent-tools.md` via
  `beae9c8` (`docs: record the live multi-step verification of POST /v1/agent`); spec
  `agent-tool-execution` — multi-step success and parser-rejection correction.

## Phase 9 — Send-Path Fix and Image Tooling

- [x] 9.1 **Wait for the send button instead of a fixed pre-send pause.** Replace the fixed pause
  with an explicit wait on the send control so a slow UI never drops the prompt.
  Files: `server.mjs`
  Evidence: `20766b7` (`fix: wait for the send button instead of a fixed pre-send pause`).

## Global Verification

- Automated baseline: `cd /home/test/test/meta-api && node --test 'agent/*.test.js'` → **38 passed /
  0 failed / 0 skipped** (15 parser + 12 sandbox + 11 loop), re-confirmed `311d45c` and after the
  cap/patience commits.
- Static check: `node --check server.mjs` clean on the branch.
- Live proof: single-step and multi-step missions verified live on `job-39368622` (7 steps,
  ~150s of 900s) with command-failure adaptation and a complete transcript.
- Sandbox proof: `selfCheck()` against a live Docker daemon proves `writeBlocked`, `fsRead`,
  `networkBlocked` and `hostHomeInvisible`, and writes nothing to the host workspace.
- Hygiene: no `systemd/` measurement state staged; runtime state is gitignored; the live broker was
  never restarted and never POSTed to during measurement round 3.

## Known Pending

- **Meta UI scraping is inherently fragile.** Completion detection depends on the end-of-message
  action bar and a multi-message grace window; Meta can change the DOM without notice. This is
  accepted as non-contractual, contained by `MAX_POLLS`, `HARD_TIMEOUT_MS` and the hard budget
  (design Open Question 1).
- **API authentication is out of scope.** The route is protected only by localhost binding; no auth
  boundary is planned for a single-operator local deployment (design Open Question 4).
- **Residual classifier indirection vector.** The read-only whitelist is textual, not a shell AST
  parser; exotic encodings/tools can still slip past. Real containment is the `:ro` mount plus
  `--network none` (design Open Question 2).
- **Recovered jobs replay from the first turn.** The loop is not checkpointed, so a restart replays
  the mission from the beginning instead of resuming from the last step (design Open Question 3).
- **`server.mjs.bak-*` leftover** remains gitignored and untracked; harmless runtime clutter.

## Traceability (requested items → tasks)

| Requested item | Task |
|---|---|
| 1. T1 selfCheck seguro | 1.1 |
| 2. T2 persistencia de identidad | 3.1 |
| 3. T3 transcript parcial en fallo | 3.4 |
| 4. T4 sin rotación para jobs agent | 3.2 |
| 5. T5 budgetMs configurable | 3.3 |
| 6. T6 validación de inputs + hardening | 2.1, 2.2, 2.3, 1.2 |
| 7. T7 suite node:test | 7.1 |
| 8. T9 docs README + gitignore | 7.2 |
| 9. Fix cap 20K→50K + knobs de paciencia | 2.4, 2.5, 3.5 |
| 10. Semáforo de completitud | 5.1, 5.2, 5.3 |
| 11. Soporte multimodal en /v1/agent | 6.1 |
| 12. Wait del botón de enviar + php/curl | 9.1, 1.4 |
| 13. Retry de negativas de Meta | 4.1 |
| 14. Verificación en vivo single/multi-paso | 8.1 |
| 15. Chore/hygiene | 7.3 |
