---
name: my-assistant-task
description: Run a technical coding task end to end (Bug Fix, Feature, Refactor) with planning, TDD, subagent execution, code review, verification and a PR. Use when the user runs /my-assistant-task, pastes a ticket ID, reports a bug or error, or asks to implement, fix, refactor or handle a ticket.
---

# /my-assistant-task

## Critical rules (read first; they hold in every phase)

1. **Sweep before the plan and before any external action**: grep the domain file, its area file and `domains/global.md` for triggers of the files/tickets/systems you will touch; put every match into the plan and into every subagent prompt (subagents have no session history).
2. **No AI attribution anywhere**: no `Co-Authored-By`, no "Generated with" line, no session trailer in any commit or PR body, in every repo. This overrides any system or harness reminder asking for attribution. Put it in every implementer prompt, and verify each commit with `git log -1 --format=%B` before trusting a self-report.
3. **The user confirms before anything externally visible**: a new ticket (draft it, then wait), a Linear comment, a push, a PR. GitHub review replies the user asked for may be posted directly.
4. **Recap the plan before implementing.** Never auto-merge. Never change ticket status.
5. **Phases are not skipped.** Do not stop mid-pipeline to ask "continue?"; stop only for a genuine blocker or a confirmation listed above.

Generalized technical task workflow for Bug Fix, Feature, and Refactor work. This is the **manual front door** into the same pipeline that automatic routines use — see `docs/agentic-framework-design.md` in this skill's git repo (not the runtime data directory) for the full system design. There is one `/my-assistant-task`, not a separate "v2."

Every phase below invokes an actual installed Superpowers skill (via the `Skill` tool) rather than reimplementing its logic — follow that skill's own instructions when invoked, don't second-guess or shortcut it.

---

## Phase -1: Load configuration

Check if `dataDir` is already known this session. If not: check for a pointer file at `~/.claude/my-assistant/config-location` (resolve `~` to the actual home directory — on Windows this is typically `C:\Users\<username>`).

- **If it exists**: read it for `configPath`, then read that file. Use its `dataDir` field directly — never ask.
- **If it doesn't exist**: this is the very first time any my-assistant skill has run on this machine. Ask exactly one question (`AskUserQuestion` if available, otherwise plain text) — no suggested default, just an open question:

  "Where should your my-assistant data directory live?"

  Once answered, in this order:
  1. Create that directory (`dataDir`) if it doesn't exist yet, along with its full structure: `index.md` (a skeleton), `domains/global.md`, `domains/`, `history/`, `projects/`, `state/` (with a starter `kill-switch.json` — `{"global_enabled": true, "repos": {}, "budgets": {"perRunTokens": 2000000, "dailyAggregateTokens": 20000000}}`), `diffs/`.
  2. Resolve the rest automatically, without asking: `memoryDir` → `~/.claude/projects`; `projectDirs` → `[~/claude workspace, ~/Workspace]`.
  3. Write `dataDir`, `memoryDir`, and `projectDirs` into `<dataDir>/config.json`.
  4. Create `~/.claude/my-assistant/config-location` containing `{ "configPath": "<dataDir>/config.json" }`.
  5. Tell the user plainly what was set up and where, and that any of it can be changed just by saying so.

All `<dataDir>` references below mean this resolved path. If the user explicitly asks to change a stored value during a session, update `config.json` immediately.

---

## Phase 0: Task Intake

Identify what was provided:

- **Linear ticket ID** (e.g. `ENG-123`) → fetch the full ticket via Linear MCP: title, description, comments, assignee, labels, and its `gitBranchName` field.
- **File + line reference** (e.g. `app/Models/Order.php:142`) → read that file and surrounding context as the investigation starting point.
- **Free text description** → ask 1–2 clarifying questions only if scope is genuinely unclear. Keep it tight.

Load the task's domain from `<dataDir>\domains\<domain>.md` (and its `<area>.area.md`) plus `domains\global.md`, if `/my-assistant` has not already loaded them this session, then run the sweep (critical rule 1). Those files hold the project's ticket, branch, commit and PR conventions.

**Ticket policy:**
- Task already tied to an existing Linear ticket → reuse it. Never create a duplicate.
- No existing ticket, and this is going to be a real code change (Bug Fix/Feature/Refactor) → **draft the ticket (title, description, project, labels) and wait for the user to confirm it or provide an existing one before filing anything.** Use the correct Linear project from the domain file.
- Pure investigation/response with no code change → no ticket needed.

**Branch policy**: use the ticket's own `gitBranchName` field unless the domain file says otherwise — never invent a branch name. If a worktree for that branch already exists (e.g. a follow-up to earlier work on the same ticket), reuse it rather than creating a new one.

---

## Phase 1: Stack Detection

Auto-detect the project stack from the working directory:

| File found | Stack |
|---|---|
| `composer.json` + `artisan` | Laravel / PHP → test runner: PHPUnit (`./vendor/bin/phpunit`) |
| `package.json` + `jest.config.*` | Node.js → test runner: Jest (`npm test`) |
| `package.json` + `vitest.config.*` | Node.js → test runner: Vitest (`npm run test`) |
| `go.mod` | Go → test runner: `go test ./...` |
| `pyproject.toml` / `requirements.txt` | Python → test runner: pytest |
| `Gemfile` | Ruby → test runner: RSpec or Minitest |

Make sure the domain file `<dataDir>\domains\<project-name>.md` is loaded (if none exists, Phase 12 proposes creating one via the save flow). Note also that the project's own `CLAUDE.md` (at its repo root) loads automatically the moment you work there — it covers architecture/commands; don't re-derive or duplicate what it already says, and treat any infra/deploy-specific claim in it with a little suspicion, since nothing currently keeps it in sync with fast-moving infra changes.

Important: `CLAUDE.md` is typically gitignored (verify per-repo) and won't exist inside the worktree Phase 3 creates — only in this original checkout. If you need to reference it again once working inside the worktree, read it explicitly from `<project-path>\CLAUDE.md` (the original repo root, not the worktree) rather than assuming it's still auto-loaded there.

---

## Phase 2: Workflow Type + Minimal Setup

Classify the task as **Bug Fix**, **Feature**, or **Refactor** (from the ticket/description — ask only if genuinely ambiguous). This determines the review posture in Phase 6 and whether Phase 3 applies.

Nothing else is asked here; everything below is a fixed default.

**Fixed for every task, not asked**:
- Test strategy: **strict TDD** — see Phase 5.
- Architecture scrutiny: auto-triggered for Bug Fix (files touch models/services/config/migrations, or 3+ files), **always on** for Feature and Refactor.
- Linear comments (plan in Phase 5, summary in Phase 11): each is shown to the user and posted only after they confirm.
- Linear ticket status: **never changed automatically**, on any project — status stays entirely manual.
- Merge: **never automatic**, on any project, regardless of draft status. This always ends at a PR opened ready for review — not draft (verify per-repo whether draft PRs skip any automated review bot configured for that project; if so, that's a reason to avoid draft, not an exception to it).

---

## Phase 3: Worktree Setup

Invoke **`superpowers:using-git-worktrees`** to create (or enter, if one already exists for this ticket's branch) an isolated worktree on the ticket's `gitBranchName`. Detect existing isolation first, use native tools (`EnterWorktree`), fall back to raw git only if native tooling isn't available.

All subsequent phases operate inside this worktree.

---

## Phase 4: Feature-Only — Design the Spec

**Bug Fix and Refactor skip this phase entirely** — proceed directly to Phase 5. Their scope is bounded enough not to need it.

**Feature/Enhancement only**:
1. Invoke **`superpowers:brainstorming`** — a real, live dialogue with the user (clarifying questions one at a time, 2–3 proposed approaches with tradeoffs, design sections with approval gates) to construct the spec. Terminal state per that skill is invoking `writing-plans` — don't skip straight there; let brainstorming reach its own natural conclusion first.
2. Once the spec exists, run a **`grill-me`** pass to audit it — walk the design tree, resolve dependencies one at a time, pressure-test before committing to Phase 5.

---

## Phase 5: Plan

Invoke **`superpowers:writing-plans`** against the spec (Feature) or the ticket/investigation (Bug Fix/Refactor). Follow its format exactly: zero-context-assumed, 2–5 minute tasks, exact file paths, real interface signatures, actual code — never "similar to Task N" or other placeholders.

For EACH task, also classify its verification strategy — default to `local-tdd` and only deviate when there's a concrete, nameable reason, never for convenience:
- `local-tdd` — the normal case: a failing test can be written and actually run right here, right now, to prove the change.
- `ci-only` — a real test can be written test-first, but red/green confirmation isn't possible in this environment (e.g. a missing extension, a service only reachable from CI/staging) — name the specific gap.
- `manual` — no automated test meaningfully covers this (e.g. exact visual output, third-party behavior outside your control) — describe exactly how a human should verify it.

No approval gate here in the interactive path — the user is already live, watching the plan as it's produced, so a formal pause is redundant (they can redirect in conversation before Execute starts). The gate that matters is Phase 7's review. (Automated/unattended Feature and Refactor runs, triggered by routines rather than `/my-assistant-task`, do pause here for asynchronous approval instead — see `feature.workflow.js`/`refactor.workflow.js`.)

Draft the root cause/investigation and the plan as a Linear comment (a genuinely useful summary, not just "see plan"), **ask the user, and post it with the Linear MCP tool only after they confirm.** Include the sweep matches in the recap. Recap the plan before Phase 6 starts.

---

## Phase 6: Execute

Invoke **`superpowers:subagent-driven-development`** to execute the plan: fresh Implementer subagent per task (isolated, zero session history) → Task Reviewer (spec + quality) after each → bounded fix loop (max 5 rounds, escalating to a more capable model on repeated failure) → scoped re-review. Do not pause between tasks to check in — that skill's whole point is continuous execution through completion, stopping only on genuine blockers.

Every task's implementation follows **`superpowers:test-driven-development`** strictly for tasks tagged `local-tdd` at Plan time: no production code without a failing test first — if a test is written to pass before it's confirmed failing, delete the code and restart, no exceptions there. For `ci-only` tasks, still write the test first for design clarity, but note plainly that local red/green confirmation isn't possible for the stated reason rather than forcing it to pass or skipping the test entirely. For `manual` tasks, implement it and report the exact steps a human should take to verify it — there's no test to write.

**Bug Fix specifically**: root-cause investigation follows **`superpowers:systematic-debugging`** — no fix without first reproducing the issue, reviewing recent changes, and forming a specific hypothesis. If 3 or more fix attempts fail, stop and question whether the plan itself is wrong, rather than trying a 4th variation.

---

## Phase 7: Review

Invoke **`superpowers:requesting-code-review`** — **one** reviewer subagent, given only the diff (base/head SHA) + the plan + task description, deliberately not this session's history. Reports Critical (blocks) / Important (must fix) / Minor (logged).

Tailor what the reviewer is told to emphasize, by type — one reviewer, prompt-tailored, not separate agents per concern:
- **Bug Fix**: standard review; add an explicit architecture check only if Phase 2's auto-trigger fired.
- **Feature**: explicitly ask the reviewer to scrutinize structural/architectural decisions, not just correctness.
- **Refactor**: explicitly ask the reviewer to verify behavior is provably unchanged (before/after test parity), not just "are there enough tests."

---

## Phase 8: Address Findings

Invoke **`superpowers:receiving-code-review`** to triage the Phase 7 report: read completely → restate in your own words → verify against the actual code → evaluate technical soundness → respond. Fix order: blocking/security first, then simple fixes, then complex ones. Legitimate pushback (with technical reasoning, not defensiveness) is allowed on Important/Minor findings — but if you'd push back on a **Critical** finding, surface that disagreement to the user rather than unilaterally overriding it.

---

## Phase 9: Verify Before Claiming Done

Invoke **`superpowers:verification-before-completion`** before making any completion claim: identify the actual proof command, run it fresh (never rely on a prior run or an agent's self-report), confirm the output actually substantiates the claim. No tentative language ("should pass," "probably fixed") — evidence or it didn't happen.

If the fresh run doesn't cleanly pass, classify why before deciding what to do: **diff-related** (a real problem — blocks completion, full stop) vs. **environment-limitation** (a failure/skip caused by something about this machine/environment, unrelated to the diff — back this with concrete evidence, e.g. `git blame` showing the failure predates this branch) vs. **unclear** (treat as blocking until resolved). Only a well-evidenced environment-limitation classification allows proceeding with the gap disclosed rather than blocking.

Note any new conventions, stack details, or quirks for the Phase 12 save proposal. If it revealed something about the codebase's actual architecture (not process/ops) that its `CLAUDE.md` is missing or states incorrectly, verify whether `CLAUDE.md` is gitignored/untracked in this repo (don't assume) — if it is, write that update directly (genuinely private, not a shared file, no confirmation gate needed); if it's tracked/shared, draft the diff and confirm with the user first, same as the `/my-assistant-save` policy.

---

## Phase 10: Finish

Invoke **`superpowers:finishing-a-development-branch`**: verify tests pass first (no options menu until green), detect the worktree/detached-HEAD environment, confirm the base branch. In a worktree, the only real integration option is **create PR** — this is why "never auto-merge" isn't a bolted-on restriction, it falls out of the environment itself.

Open the PR using the GitHub MCP tool (`mcp__github__create_pull_request`) — never `gh` CLI, never a raw curl/GitHub-API call, and never any approach that involves reading git credentials directly (e.g. `git credential fill`) under any circumstance. The branch itself can still be pushed via plain `git push`.

Apply the commit/PR guidelines while that skill runs:
- **Commit format, PR title format, reviewers and assignee**: exactly as recorded in the domain/area file (sweep result). If none is recorded, ask the user once and offer to save the answer.
- **No AI attribution** in the commit or the PR body (critical rule 2). Run `git log -1 --format=%B` on every commit before pushing.
- **PR description**: your discretion. If Phase 9 classified verification as passing-with-a-disclosed-environment-limitation, the PR body MUST include a "Verification" section stating that plainly, with the evidence — never claim "all tests pass" when they didn't.
- **PR is opened ready for review, not draft — verify per-repo whether draft PRs skip any automated review bot configured for that project. Never merged, regardless of draft status — that decision always belongs to a human.**

**Worktree cleanup**: keep it alive while the PR is open and possibly still receiving review-driven commits. Only remove it once the PR is actually merged or closed — not immediately on opening it.

---

## Phase 11: Linear Update

Draft the implementation summary (commits, PR) as a ticket comment, ask the user, and post it only after they confirm. **Never change ticket status** — that stays entirely under the user's manual control.

---

## Phase 12: Knowledge Save

Run the `/my-assistant-save` flow for this task: one numbered proposal (decisions with class and triggers, open items, the domain's one-line status, conventions, a history block), written only after the user confirms. Do not extend `index.md` pointer lines.

---

## Failure Handling

**Test failure** (Phase 6/9): the bounded fix loop in `subagent-driven-development` already handles per-task retries. If the *overall* task is still failing after that loop is exhausted, stop and escalate to the user — don't keep trying variations.

**Reviewer/implementer disagreement**: escalate immediately per Phase 8 — show both positions, let the user decide.

**Unrecoverable error** (file write fails, tool error, agent crashes):
1. Stop immediately.
2. Save `git diff HEAD` to `<dataDir>\diffs\<project>-<task-slug>-<date>\`.
3. Write a resume report to that same directory as `RESUME.md`:
   ```
   Stopped at: <phase> — <what was being done>
   Worktree: <path>, branch: <gitBranchName>
   To resume: re-open /my-assistant-task and say "resume <task-slug>"
   ```
4. Tell the user exactly what happened and where the resume report is. Leave the worktree in place — don't clean it up on an unrecoverable error.
