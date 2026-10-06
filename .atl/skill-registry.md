# Skill Registry — meta-api

Generated: 2026-10-06
Scope: workspace `/home/test/test/meta-api` (branch `feat/agent-tools`)
Scan: user skills at `~/.config/opencode/skills`; project skills at `{project-root}/skills`, `.opencode/skills` (none present).

The registry is an index. Subagents receive these exact paths and read each `SKILL.md` for the source of truth.

## User-level skills

| Name | Trigger | Path | Scope |
| ---- | ------- | ---- | ----- |
| chained-pr | PRs over 400 lines, stacked PRs, review slices | `~/.config/opencode/skills/chained-pr/SKILL.md` | user |
| cognitive-doc-design | Writing guides, READMEs, RFCs, onboarding, architecture, review-facing docs | `~/.config/opencode/skills/cognitive-doc-design/SKILL.md` | user |
| go-testing | Go tests, `go test` coverage, Bubbletea teatest, golden files | `~/.config/opencode/skills/go-testing/SKILL.md` | user |
| judgment-day | Judgment day, dual review, adversarial review | `~/.config/opencode/skills/judgment-day/SKILL.md` | user |
| skill-creator | New skills, agent instructions, documenting AI usage patterns | `~/.config/opencode/skills/skill-creator/SKILL.md` | user |
| skill-improver | Improve/audit/refactor skills | `~/.config/opencode/skills/skill-improver/SKILL.md` | user |
| work-unit-commits | Implementation, commit splitting, chained PRs, tests+docs with code | `~/.config/opencode/skills/work-unit-commits/SKILL.md` | user |

Excluded by scan rules: `sdd-*`, `_shared`, `skill-registry`.

## Project convention files

| File | Notes |
| ---- | ----- |
| — | No `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `GEMINI.md`, or `copilot-instructions.md` inside the repo. |

Note: `~/.config/opencode/AGENTS.md` (user-level) governs agent behavior for this session.
