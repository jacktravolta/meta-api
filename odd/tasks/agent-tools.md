# meta-api: agent tools execution — hardening & completion

## Objective
Take the existing agent (POST /v1/agent: shell-command protocol over Meta AI + Docker sandbox)
from "single-step verified live" to reliable, secure multi-step tool execution: fix the
mapped security/reliability defects, validate inputs, add a test foundation, and verify live
(single + multi-step) once measurement round 3 releases the broker.

## Problem
The previous session built the full loop (agent/{sandbox.js,tools.js,loop.js}, Dockerfile.sandbox,
server.mjs wiring) and verified one live step (914ms). Multi-step never completed. Exploration
(2026-10-05) mapped the current tree and found concrete defects:

1. **selfCheck probes with allowWrite:true** (sandbox.js:143) contradicting its own comment
   (L136-137). The probe writes `.sandbox-probe` into the HOST workspace on every verified
   request; the returned object has no `writeBlocked` field and the route never checks one.
   Physical proof: /home/test/test/.sandbox-probe exists, content `x`.
2. **persistPending drops agent identity** (server.mjs:1550): a restarted agent job replays as
   a plain chat completion — raw task to Meta, no protocol, no sandbox.
3. **Rotation is computed then discarded for agent jobs** (server.mjs:1626-1641 runs before the
   agent branch L1642+): spends a full Meta turn + thread deletion for nothing.
4. **budgetMs hardcoded 180000** (loop.js:12): with real Meta turns of 20-90s, multi-step dies
   on "budget" after ~2-4 steps regardless of rate limits.
5. **Mid-loop failure loses the transcript**: ask() throws (the rate-limit path) propagate to
   pump's catch; agentResult is only assigned on success.
6. **Unvalidated inputs**: `workdir` reaches `-v` unvalidated (any host path mountable);
   maxSteps/task unbounded.
7. **No tests anywhere in the repo.**
8. Hygiene: README never documents /v1/agent; .gitignore L8 is a corrupted line (`*.logagent/`).

## Why
The user's goal is meta-api executing tools. The protocol insight is already proven (Meta emits
shell commands when framed as commands, not tools); what remains is making the loop trustworthy
enough to actually use: security posture that matches its own comments, recovery that preserves
the agent path, budgets that allow multi-step, inputs that can't mount arbitrary host paths,
and regression tests so the next change can't silently reopen a hole.

## Current state (from the exploration map)
- Branch `feat/agent-tools` (from main @ 31c7056). Implementation fully wired and live:
  route L1781, submitAgent L1509, pump agent branch L1642, poll passthrough L1836.
- Parser (tools.js:43-97): fence regex + SHELL_TAGS filter (untagged accepted, python rejected
  since c9c88c1), last surviving block wins, prompt markers stripped; JSON form = legacy path.
- Sandbox (sandbox.js): classify() deny-by-default (WRITE_MARKERS blocklist + per-segment
  READ_ONLY whitelist), docker run with --network none/--read-only/--cap-drop=ALL, double
  timeout brake (inner timeout + host-side docker kill by name), output capped 8192.
- Known residual vector: whitelist is textual — `$(...)`, backticks, `find -exec`, `awk system()`
  classify as read-only; currently contained only by the :ro mount + no network.

## Authorized scope / constraints
- Work ONLY on branch feat/agent-tools.
- NEVER stage or commit anything under systemd/ (medicion.conf is measurement-transient state
  for round 3, still running).
- NEVER restart/reload the meta-api service, NEVER POST to 127.0.0.1:8055 (the live broker is
  running measurement round 3; edits to server.mjs on disk do not affect the running process).
- No live Meta verification in this phase (task T10 is explicitly gated on round 3 finishing).
- Unit tests + node --check + docker-only smoke are allowed (docker never touches Meta).

## Tasks
- [x] T1 (security) Fix selfCheck to probe the DEFAULT policy (allowWrite:false): split the
  probe so the fs/network sub-probes classify as reads, assert the write attempt is DENIED
  (writeBlocked:true means denied-by-policy, never executed), add writeBlocked to the 503 gate
  in the route, and delete the leaked /home/test/test/.sandbox-probe.
- [x] T2 persist agent identity: persistPending/loadPending carry
  {agent, maxSteps, budgetMs, allowWrite, allowNetwork, workdir}.
- [x] T3 preserve the partial transcript on mid-loop failure: runAgentLoop catches ask()
  throws and resolves {ok:false, reason:"meta-error:<msg>", steps, transcript}; pump sets
  j.content + j.agentResult from that instead of erroring the job blind.
- [x] T4 skip the pre-pump context rotation for agent jobs (j.agent): no wasted Meta turn, no
  thread deletion mid-mission.
- [x] T5 make the loop budget real: budgetMs request field (clamped 30s..3600s) +
  META_AGENT_BUDGET_MS env default 900000, persisted with the job, used by runAgentLoop.
- [x] T6 validate inputs: workdir must resolve (realpath) inside META_SANDBOX_WORKDIR_ROOTS
  (colon-separated, default /home/test/test) or 400; maxSteps clamp 1..32; task <= 8000 chars.
  Harden the classifier for the residual vector: deny command substitution ($(...), backticks),
  find -exec/-delete, xargs, and awk/sed system() shapes in read-only mode.
- [x] T7 test foundation with node:test (no new deps): parser cases (tagged/untagged fences,
  Shell sh prefix, python rejected, empty/oversized, JSON form, last-block-wins, marker
  stripping), classifier cases (read pass, write deny, per-segment pipes, substitution deny),
  loop cases with a stubbed ask (multi-step success, parser-rejection correction, maxSteps,
  budget, meta-error preserves transcript).
- [x] T8 docker verification (parent): docker version/images/ps, sandbox-only smoke via direct
  import (no broker).
- [x] T9 document: README endpoint list + /v1/agent contract; fix .gitignore L8.
- [x] T10 (gated on round 3 completion) live smoke: single-step then multi-step via
  POST /v1/agent, watching journal agent events.

## Acceptance criteria
- selfCheck no longer writes anything to the host; writeBlocked:true asserted and gated.
- A restarted agent job resumes as an agent job (identity persisted end-to-end).
- Agent jobs never trigger context rotation.
- A 3-step live agent task completes within budget (T10, after round 3).
- node --test agent/ passes; node --check server.mjs clean.
- Every task lands as its own work-unit commit (tests with the behavior they pin).

## Verification
- Per task: node --check server.mjs + the relevant tests, observed by the parent.
- Parent spot-check: re-run one command before delivery.
- Full functional proof: T10 live runs (gated).

## Out of scope (recorded, not done now)
- Untrack systemd/medicion.conf from git once round 3 ends (watchdog deletes it on purpose).
- server.mjs.bak-20261003-211127 leftover (gitignored).
- API auth (localhost binding remains the only control).
- ODD route log: T1-T7+T9 = delegated writer; T8, T10 = parent.


## Ejecución (2026-10-05)
- T1-T7+T9: delegados y completados, 8 commits 77fdf1e..920e266, 35/35 tests.
- T8: verificación parent: suite re-ejecutada 35/35 (~1.4s), 0 archivos systemd/ tocados, selfCheck docker vivo sin leak.
- T10: VERIFICADO EN VIVO (05-oct, job-39368622): tarea de conteo de lineas resuelta en 7 steps con adaptacion a error (wc fallo -> find -> respuesta correcta '2067 lineas'), fences sin tag, transcript completo, budget ok (~150s de 900s). Broker en produccion (budget 150K, idle 30s) corriendo el codigo del branch.
