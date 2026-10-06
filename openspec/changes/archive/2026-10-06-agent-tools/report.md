# Archive Report: agent-tools

> Terminal record of the SDD cycle for the `agent-tools` change. This change was registered
> retroactively: it documents work that was already implemented, verified and committed on
> branch `feat/agent-tools` at the time it entered SDD. This report describes the state of the
> change AT CLOSE.

- **Change**: `agent-tools`
- **Store**: openspec (repo-local)
- **Archived to**: `openspec/changes/archive/2026-10-06-agent-tools/`
- **Archive date**: 2026-10-06
- **Cycle status**: complete for the retrospective record (all tasks checked; specs promoted)

## Final Status

The change is **complete and archived**. All 24 tasks across 9 phases are marked `[x]` in
`tasks.md`; the five new capabilities have been promoted as full specs into the source of truth.
The implementation lives on branch `feat/agent-tools`; `main` is untouched.

Note on counts: `tasks.md` and `proposal.md` state "25 commits (`db4a1e8..40558a2`)". The
observed count is **24 commits** ahead of `main` (`git rev-list --count main..HEAD` = 24;
`git rev-list --count db4a1e8^..40558a2` = 24). The one-commit variance is recorded as an
observed discrepancy; it does not affect task completion, which is the authoritative signal.

No `verify-report.md` was produced for this change (verification was carried as final-state
facts in the archive launch and in `tasks.md` "Global Verification"). This is recorded, not
treated as a failure.

## Capabilities Promoted

`openspec/specs/` was empty before this archive; every capability below is NEW. Each delta spec
was a full spec (not a delta), so each was copied mechanically (shell `cp` + `diff -r` readback,
empty diff) into the source of truth.

| Capability | Promoted spec path | Delta source |
|-----------|--------------------|--------------|
| `agent-tool-execution` | `openspec/specs/agent-tool-execution/spec.md` | `openspec/changes/archive/2026-10-06-agent-tools/specs/agent-tool-execution/spec.md` |
| `agent-sandbox-hardening` | `openspec/specs/agent-sandbox-hardening/spec.md` | `openspec/changes/archive/2026-10-06-agent-tools/specs/agent-sandbox-hardening/spec.md` |
| `agent-job-lifecycle` | `openspec/specs/agent-job-lifecycle/spec.md` | `openspec/changes/archive/2026-10-06-agent-tools/specs/agent-job-lifecycle/spec.md` |
| `agent-input-validation` | `openspec/specs/agent-input-validation/spec.md` | `openspec/changes/archive/2026-10-06-agent-tools/specs/agent-input-validation/spec.md` |
| `agent-multimodal-input` | `openspec/specs/agent-multimodal-input/spec.md` | `openspec/changes/archive/2026-10-06-agent-tools/specs/agent-multimodal-input/spec.md` |

All five were created; none modified or removed pre-existing requirements (none existed).

## Verification Evidence

Final-state facts (from `tasks.md` "Global Verification" and the archive launch):

- **Automated suite**: `cd /home/test/test/meta-api && node --test 'agent/*.test.js'` →
  **38 passed / 0 failed / 0 skipped** (15 parser + 12 sandbox + 11 loop). Re-confirmed at
  commit `311d45c` and again after the command-cap and patience changes.
- **Static check**: `node --check server.mjs` clean on the branch.
- **Live multi-step proof**: `job-39368622` completed a line-count mission in 7 steps, adapting
  from a failed `wc` to `find` and answering `2067 lineas`, consuming ~150 s of the 900 s budget
  with a complete transcript and optional-tag fences.
- **Sandbox proof**: `selfCheck()` against a live Docker daemon proved `writeBlocked`, `fsRead`,
  `networkBlocked`, `hostHomeInvisible`, and wrote nothing to the host workspace (no host leak).

## What Shipped

The broker (`meta-api`) became an agent runtime behind `POST /v1/agent`:

- **Tool loop over shell** — natural-language task → fenced shell command → ephemeral Docker
  execution → output feedback → final plain-text answer, bounded by `maxSteps` (1..32, default 8)
  and a wall-clock budget. Result returned as `agent:{ok,reason,steps,transcript}` via
  `GET /v1/jobs/{job_id}`.
- **Sandbox hardening** — per-command `--rm --network none --read-only --cap-drop=ALL`
  container, deny-by-default textual classifier with an indirection blocklist, double timeout
  brake, 8192-byte output cap, `selfCheck` write-denied policy probe gating the route with `503`,
  and a `meta-sandbox:1` image with `php-cli`/`curl` baked in.
- **Job lifecycle & patience** — agent identity persisted across restarts, agent jobs skip
  context rotation, configurable `budgetMs` (30 s..1 h, default 900000), partial transcript
  preserved on mid-loop Meta failure.
- **Input validation** — `workdir` `realpath`-confined to `META_SANDBOX_WORKDIR_ROOTS`,
  `maxSteps` clamp, `task` cap at 8000 chars, `allowWrite` requires `allowWriteAck:true`,
  per-request `sandboxTimeoutMs` (5 s..600 s).
- **Meta loop reliability** — bounded retry of generic Meta refusals; end-of-message action bar
  (plus a multi-message grace window) as the only completion semaphore; send button awaited.
- **Multimodal input** — `images[]` (`data:image/*`, max 4) accepted on `POST /v1/agent` and
  attached on the first turn only.
- **Tests & documentation** — native `node:test` suite (zero new dependencies) pinning parser,
  classifier, loop and `selfCheck`; README documents the endpoint list and the full `/v1/agent`
  contract.

## Known Pending / Accepted Limits

- **Meta UI scraping is inherently fragile.** Completion detection depends on the
  end-of-message action bar and a multi-message grace window; Meta can change the DOM without
  notice. Accepted as non-contractual, contained by `MAX_POLLS`, `HARD_TIMEOUT_MS` and the hard
  budget (design Open Question 1).
- **API authentication is out of scope.** The route is protected only by localhost binding; no
  auth boundary is planned for a single-operator local deployment (design Open Question 4).
- **Residual classifier indirection vector.** The read-only whitelist is textual, not a shell
  AST parser; exotic encodings/tools can still slip past. Real containment is the `:ro` mount
  plus `--network none` (design Open Question 2).
- **Recovered jobs replay from the first turn.** The loop is not checkpointed, so a restart
  replays the mission from the beginning instead of resuming from the last step (design Open
  Question 3).
- **`server.mjs.bak-*` leftover** remains gitignored and untracked; harmless runtime clutter.

## Delivery Status

- The work lives on branch **`feat/agent-tools`** (24 commits ahead of `main`, range
  `db4a1e8..40558a2`), delivered as small single-purpose work units. `main` is intact.
- **Merge / PR is pending the user's decision.** No merge to `main` and no PR was opened during
  this SDD cycle.
- The `openspec/` tree was untracked at archive time, so the archive performed a sanctioned
  plain `mv` fallback (after a failed `git mv` on untracked paths). The user decides the archive
  commit.
- **No code was modified and no commit was made by the archive phase.**

## Archive Integrity

- Spec promo copy verified via `diff -r` (empty output for all five capabilities).
- Archive move verified via recursive pre-move snapshot `diff -r` against the destination
  (empty output).
- Promoted specs and archived delta specs are byte-identical (matching SHA-256 per capability).
- Preserved inside the archive: `proposal.md`, `design.md`, `tasks.md`, and `specs/**` (5
  capabilities). This `report.md` is additive and did not exist in the source change folder.
