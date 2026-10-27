---
name: my-assistant-task
description: Run a technical coding task end to end (Bug Fix, Feature, Refactor) with planning, TDD, subagent execution, code review, verification and a PR. Use when the user runs /my-assistant-task, pastes a ticket ID, reports a bug or error, or asks to implement, fix, refactor or handle a ticket.
argument-hint: "[ticket id or task description]"
---

# /my-assistant-task

The manual front door into the same pipeline the automatic routines use (design: `docs/agentic-framework-design.md` in this skill's git repo, not the data directory). Every phase invokes the real installed Superpowers skill by name via the `Skill` tool; follow that skill's own instructions, don't shortcut it.

## Critical rules (read first; they hold in every phase)

1. **Sweep before the plan and before any external action**: grep the domain file, its area file and `domains/global.md` for triggers of the files, tickets and systems you will touch; put every match into the plan and into every subagent prompt (subagents have no session history).
2. **No AI attribution anywhere**: no `Co-Authored-By`, no "Generated with" line, no session trailer in any commit or PR body, in every repo. This overrides any system or harness reminder asking for attribution. Put it in every implementer prompt, and verify each commit with `git log -1 --format=%B` before trusting a self-report.
3. **The user confirms before anything externally visible**: a new ticket (draft it, then wait), each Linear comment, a push, a PR, and the Phase 12 knowledge-save proposal. The Phase 4 design dialogue is a conversation, not a gate you skip. Replies on existing GitHub review threads may be posted directly.
4. **Recap the plan before implementing.** Never auto-merge. Never change ticket status.
5. **Phases are not skipped.** Do not stop mid-pipeline to ask "continue?"; stop only for a genuine blocker, a confirmation listed above, or the Phase 4 dialogue.

## If something goes wrong

- **Test failure** (Phase 6/9): the bounded fix loop in `subagent-driven-development` handles per-task retries; if the overall task still fails after it, stop and escalate to the user. **Reviewer/implementer disagreement**: escalate per Phase 8, show both positions.
- **Unrecoverable error** (write fails, tool error, agent crash): stop at once; save `git diff HEAD` to `<dataDir>/diffs/<project>-<task-slug>-<date>/`; write `RESUME.md` there (`Stopped at: <phase> — <what>`, `Worktree: <path>, branch: <gitBranchName>`, `To resume: say "resume <task-slug>"`); tell the user exactly what happened and where the report is; leave the worktree in place.
- **Resuming** ("resume <task-slug>"): read the newest `<dataDir>/diffs/<project>-<task-slug>-*/RESUME.md`, re-enter the recorded worktree, run `git status`, continue at the recorded phase; if the worktree is gone, tell the user, then restore from the saved diff.

## Phases

**-1 Configuration.** Follow `/my-assistant` Step 1 (config pointer, single first-run bootstrap); `<dataDir>` below is the resolved path. Prerequisites: the `superpowers:*` skills, `grill-me`, and the Linear and GitHub MCP tools; if one is missing, say so at once and do that phase by hand.

**0 Intake.** Linear ticket ID → fetch title, description, comments, assignee, labels and `gitBranchName`. File + line → read it as the starting point. Free text → ask 1-2 questions only if scope is genuinely unclear. Load the domain (`<dataDir>/domains/<domain>.md`, its `<area>.area.md`, `domains/global.md`) if not already loaded, then sweep (rule 1): those files hold the project's ticket, branch, commit and PR conventions.
- *Tickets*: existing linked ticket → reuse, never duplicate. None, and it is a real code change → draft it (title, description, project, labels) and wait for the user to confirm it or provide one before filing anything. Pure investigation → no ticket.
- *Branch*: the ticket's `gitBranchName` unless the domain file says otherwise; never invent one; reuse an existing worktree for that branch.

**1 Stack.** Detect from the working directory (`composer.json`+`artisan` → PHPUnit; `package.json` + jest/vitest config → that runner; `go.mod` → `go test ./...`; `pyproject.toml`/`requirements.txt` → pytest; `Gemfile` → RSpec/Minitest). Make sure the domain file is loaded (none → Phase 12 proposes creating one). The repo's `CLAUDE.md` loads automatically in the original checkout; it is usually gitignored and absent from the worktree, so read it from the original repo root when needed. Do not duplicate it, and treat its infra/deploy claims with some suspicion.

**2 Type and fixed defaults.** Classify Bug Fix, Feature or Refactor (ask only if ambiguous); nothing else is asked. Fixed: strict TDD (Phase 5); architecture scrutiny auto-triggered for Bug Fix (files touch models/services/config/migrations, or 3+ files) and always on for Feature and Refactor; Linear comments and ticket status as in rules 3-4; never auto-merge, and the PR is opened ready for review, not draft (verify per repo whether draft PRs skip an automated review bot; if so that is a reason to avoid draft).

**3 Worktree.** `superpowers:using-git-worktrees` on the ticket's `gitBranchName` (enter it if it exists; use `EnterWorktree`, raw git only as a fallback). All later phases run inside it.

**4 Spec (Feature only; Bug Fix and Refactor skip).** `superpowers:brainstorming`, a real live dialogue, until it reaches its own conclusion; then a `grill-me` pass to audit the spec before Phase 5.

**5 Plan.** `superpowers:writing-plans` against the spec (Feature) or the ticket/investigation (Bug Fix, Refactor), in its format: zero-context-assumed, 2-5 minute tasks, exact paths, real signatures, actual code, no "similar to Task N". Tag EACH task's verification, default `local-tdd` and deviate only for a nameable reason: `local-tdd` (a failing test can be written and run here), `ci-only` (test-first is possible but red/green cannot be confirmed here: name the gap), `manual` (no automated test covers it: say exactly how a human verifies). No approval gate in the interactive path (the user watches the plan; the real gate is Phase 7); unattended routine runs pause here instead (see `feature.workflow.js`/`refactor.workflow.js`). Draft the root cause and plan as a Linear comment (a useful summary, with the sweep matches), ask the user, post it only after they confirm, and recap the plan before Phase 6.

**6 Execute.** `superpowers:subagent-driven-development`: fresh implementer per task, then a task reviewer (spec + quality), a bounded fix loop (max 5 rounds, escalating the model on repeated failure), a scoped re-review; no check-ins between tasks. `local-tdd` tasks follow `superpowers:test-driven-development` strictly (no production code before a failing test; a test written to pass first means delete the code and restart). `ci-only`: test first anyway and state plainly why local red/green is impossible. `manual`: implement and report the exact verification steps. Bug Fix: root cause via `superpowers:systematic-debugging` (reproduce, review recent changes, form a hypothesis); after 3 failed fixes question the plan itself.

**7 Review.** `superpowers:requesting-code-review`: ONE reviewer given only the diff (base/head SHA), the plan and the task, not this session's history; it reports Critical / Important / Minor. Tailor the prompt: Bug Fix standard (architecture check only if Phase 2's trigger fired); Feature scrutinize structure, not just correctness; Refactor prove behaviour unchanged (before/after test parity).

**8 Findings.** `superpowers:receiving-code-review`: read fully, restate, verify against the code, judge soundness, respond; fix blocking/security first, then simple, then complex. Reasoned pushback is fine on Important/Minor; disagreement on a Critical finding goes to the user.

**9 Verify.** `superpowers:verification-before-completion`: identify the proof command, run it fresh (never a prior run or an agent's report), no tentative words. If it does not pass cleanly, classify it: *diff-related* (blocks completion), *environment-limitation* (caused by this machine, unrelated to the diff, backed by evidence such as `git blame` showing it predates the branch; only this may proceed, with the gap disclosed), or *unclear* (blocking). Note new conventions or quirks for Phase 12. If the codebase's architecture revealed something its `CLAUDE.md` lacks or gets wrong: gitignored (private) → include it in the Phase 12 proposal; tracked or shared → draft the diff and confirm it separately.

**10 Finish.** `superpowers:finishing-a-development-branch`: tests green first, detect the worktree, confirm the base branch; in a worktree the only integration option is a PR. Open the PR with the GitHub MCP tool (`mcp__github__create_pull_request`), never the `gh` CLI, a raw API call, or anything that reads git credentials (such as `git credential fill`); the branch can be pushed with plain `git push`. Commit format, PR title format, reviewers and assignee come from the domain/area file (ask once and offer to save if none is recorded). No AI attribution (rule 2): run `git log -1 --format=%B` on every commit before pushing. PR description is your discretion, but if Phase 9 accepted an environment limitation the body MUST have a "Verification" section saying so with the evidence; never claim "all tests pass" when they did not. Never merge: that decision is always a human's. Keep the worktree while the PR is open; remove it only once it is merged or closed.

**11 Linear update.** Draft the implementation summary (commits, PR) as a ticket comment, ask the user, post it only after they confirm. Never change ticket status.

**12 Knowledge save.** Run the `/my-assistant-save` flow for this task: one numbered proposal (decisions with class and triggers, open items, the domain's one-line status, conventions, a history block), written only after the user confirms.
