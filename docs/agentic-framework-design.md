# my-assistant Agentic Framework Design

**Scope**: this document describes the architecture of the optional automated/unattended pipeline (Section 2 onward) that sits behind `/my-assistant-task`. It's a design reference, not a build log — implementation history, real run data, and incident write-ups for a specific deployment belong in that deployment's own `projects/<framework-name>.md` file (per the knowledge-store convention in Section 9), not here.

## 1. Vision

`/my-assistant-task` is, by default, an interactive, human-paced workflow: the user invokes it, answers a few setup questions, and stays in the loop at every gate. This design generalizes it into a personal agentic framework — a single point of truth **main agent** that handles both:

- **Manual work**: the user invoking `/my-assistant-task` directly, same as always.
- **Automatic work** ("routines"): the same underlying engine triggered by events from GitHub, Linear, Sentry, and Slack, running unattended.

"Single point of truth" means the **dispatch/orchestration logic is shared** — not that there's literally one polling loop. Manual and automatic paths funnel into the same set of workflow types, the same review mechanism, the same knowledge store. The only real differences are how a task starts and what gates it hits along the way.

## 2. Trigger Mechanism (polling, not webhooks)

- **Five separate `CronCreate`-scheduled jobs**: one per platform (GitHub, Linear, Sentry, Slack) on its own cadence — time-sensitive platforms (Slack, Sentry) poll more frequently than GitHub/Linear — plus one for the **Monitoring Digest** on a daily cadence.
- All five call into the **same shared dispatch logic** (the "single point of truth"). Each detector: fetch new events since last checkpoint → classify each → dedup-check → dispatch.
- Runs entirely inside the existing Claude Code environment — no hosting, no server.
- **Why not real webhooks**: webhooks require a hosted, publicly reachable backend, which in turn would need a structured (non-local-file) knowledge store as a prerequisite — solving that problem before knowing whether the workflows themselves are good is premature infrastructure investment. A reasonable Phase 2 direction, not a Phase 1 requirement.

## 3. Project Scope

The repos this pipeline operates on are entirely configuration-driven — see `config.json`'s `repos` array (each entry: `name`, `projectPath`, `owner`, `hasSentry`, and an optional `sentryProject` for when the Sentry project name differs from the repo name). All configured repos are treated **identically by default** — no per-repo exceptions unless deliberately added, since the no-auto-merge policy plus mandatory human PR review is the actual safety backstop regardless of a given repo's stakes.

## 4. Workflow Taxonomy (5 types)

| Type | Touches code? | Needs worktree? | Needs a ticket? |
|---|---|---|---|
| Bug Fix | Yes | Yes | Yes |
| Feature | Yes | Yes | Yes |
| Refactor | Yes | Yes | Yes |
| Investigate-and-Respond | No (usually) | No | No |
| Monitoring Digest | No | No | No |

**Investigate-and-Respond** can escalate mid-run into one of the three code-change types. Escalation is **parent-mediated**, not a nested `workflow()` call: it returns a structured signal (`{escalate: true, to: 'bug-fix', context: {...}}`), and the dispatcher that invoked it inspects that result and separately calls `workflow('bug-fix', {...})` itself — respecting the `Workflow` tool's one-level-nesting limit.

**Monitoring Digest** is time-driven (fires on a schedule), not event-driven, and produces one rollup rather than N per-event responses. No worktree, no code-change pipeline, no adversarial review agent — just a lightweight completeness check (did it actually query every in-scope platform/repo). Posts as a DM to whatever `config.json`'s `notify` field specifies.

**Classifying which of the three code-change types applies is pure LLM judgment, not a rule engine.** The classification step (Section 12) just asks the agent to pick `bug-fix`/`feature`/`refactor`/`investigate-and-respond`/`no-op` with a `reasoning` field — nothing further distinguishes the three. In practice: Bug Fix = something is broken relative to intended behavior; Feature = new capability that didn't exist before; Refactor = restructuring existing code without changing external behavior or adding capability.

## 5. Supervision Policy: "Propose, don't act"

Auto-triggered tasks investigate, plan, execute, and self-review **fully autonomously** — but always stop before anything externally visible or hard-to-reverse: open the PR as ready-for-review (not draft, so any automated review bot still runs — see `/my-assistant-task`), never merge; draft a reply, never send unreviewed.

**Exception — Feature/Enhancement gets an earlier gate**: Feature workflows stop *before execution starts*, not just before merge:
- **Manual invocation**: a real, live `grill-me` session with the user.
- **Automatic trigger**: a **self-interview simulation** — walks the same dependency-ordered decisions `grill-me` would, resolving each itself and documenting the reasoning in the eventual draft PR. Before running the full self-interview ceremony, it first extracts whatever the ticket already answers explicitly (a stated preferred approach, a named format, an explicit constraint) and treats those as pre-resolved — only walking what's genuinely still open.

**One deliberate exception to "propose, don't act": `CLAUDE.md`.** If it's confirmed gitignored and untracked in a given repo (verify via `git check-ignore` + `git ls-files` — don't assume this holds across every repo), it's genuinely private, never seen by a team — so the Knowledge Save phase (Section 19) writes to it directly, no confirmation gate. This isn't a relaxation of the policy; the policy is about not acting on anything *externally visible*, and a gitignored file isn't.

## 6. The Development Pipeline (Bug Fix / Feature / Refactor)

Composed of installed Superpowers skills, wrapped in orchestration logic:

```
Orientation (front-loaded, mandatory)
  → (Feature only: Spec — pre-resolve what the ticket answers, self-interview or live grill-me for the rest)
  → Setup (worktree; check for existing commits on this branch first)
  → Plan (root-cause/behavior-baseline; writing-plans; per-task verification-strategy tagging)
  → Execute (sequential per-task loop, not one atomic call)
  → Review (requesting-code-review, one reviewer, prompt-tailored by type)
  → Verify (verification-before-completion; failure classification)
  → Finish (finishing-a-development-branch; GitHub MCP only)
  → Knowledge Save
```

**Orientation is front-loaded and mandatory, not appended.** Every Setup and Plan prompt opens with an explicit, numbered instruction to read four things before anything else: the repo's own `CLAUDE.md` (main checkout path, not the worktree — see below), `index.md`, `projects\<repo>.md`, and the repo's per-directory Claude memory (`.claude\projects\<hash>\memory\MEMORY.md`, computed from the working directory path, present only for repos with prior interactive sessions there). Putting this at the *front* of the prompt (rather than appended as a soft "read if present" note) matters — an agent absorbing a large Spec block first tends to go straight to code exploration and skip anything appended after it. `CLAUDE.md` does **not** auto-load into `Workflow`-tool subagents the way it does for interactive sessions, and it's typically gitignored, so it isn't checked out into a fresh worktree at all — any prompt needing it must point at the main checkout path (`projectPath`), never the worktree path.

**Setup and Plan check for prior work on the branch before planning.** Since a worktree can be a reused one from earlier work on the same ticket, Plan is instructed to run `git log --oneline` against the branch's base first and read what any existing commits actually did before planning — so a restart doesn't re-plan or duplicate work already committed.

**Plan returns a lightweight task index, not the full plan text.** `writing-plans` still produces the full, code-complete plan (zero-context-assumed, exact file paths, real code) and saves it to disk — that stays the source of truth. Plan's structured return is just `rootCause`/`planSummary`/`planFilePath` plus a `tasks: [{id, title}]` list; Execute reads the file directly per task instead of the whole plan being re-injected into every subsequent prompt — re-pasting the full plan text into every Execute prompt is a real, avoidable token cost driver.

**Task granularity favors grouping over atomizing.** `writing-plans`' own "2-5 minute tasks" guidance is followed, but with an explicit override: closely-related, mechanically-similar changes (the same kind of accessor on two sibling models, a new file plus its registration plus its test) get grouped into one task rather than split purely to stay under 5 minutes, because each task carries a largely fixed ceremony cost (fresh-Implementer framing, review pass, red/green cycle) regardless of how small the change is.

**Execute is a sequential per-task loop, not one atomic call.** Each task gets its own `agent()` call, invoking `subagent-driven-development` (fresh Implementer → Task Reviewer → bounded fix loop, max 5 rounds, escalating model capability on repeated failure → scoped re-review) and `test-driven-development` strictly. Being separate, cached calls means an interruption mid-Execute only loses the in-flight task — completed tasks replay from cache on resume. Every task also carries a **verification strategy**, decided at Plan time and defaulting to `local-tdd`:
- `local-tdd` — the normal case, a failing test can actually be run right here.
- `ci-only` — a real test can be written test-first, but local red/green confirmation isn't possible (a missing extension, a service only reachable from CI) — named explicitly in `verificationNotes`.
- `manual` — no automated test meaningfully covers this; the task reports exact manual verification steps instead.

`systematic-debugging`'s "3+ failed fixes → pause and question the architecture" applies per-task.

**Verify classifies *why* a fresh run doesn't pass cleanly, rather than treating any non-pass as a hard stop.** Given the pre-declared verification-strategy gaps from Plan as grounding context, Verify classifies a failure as `diff-related` (a real problem — blocks, full stop), `environment-limitation` (backed by concrete evidence, e.g. `git blame` showing the failure predates this branch, or a directly-confirmed missing capability — unrelated to the diff), or `unclear` (treated as blocking, same as `diff-related`, until a human resolves it). Only a well-evidenced `environment-limitation` classification lets the run proceed to a PR with the gap explicitly disclosed in the PR body (`status: 'pr-opened-with-caveats'`, distinct from a clean `pr-opened`) — this exists because the alternative to a well-evidenced environment gap is either a false "all tests pass" claim or an indefinitely blocked, otherwise-correct fix.

**Finish only uses the GitHub MCP tool.** `mcp__github__create_pull_request` — never `gh` CLI, a raw curl/API call, or any approach touching git credentials directly (see Section 18 for why this is a hard rule, not a preference).

**Every successful run ends in a Knowledge Save phase** (Section 19).

## 7. Review Agents Per Type

| Type | Reviewer | Notes |
|---|---|---|
| Bug Fix | Single `requesting-code-review`-style agent | Architecture concern folded into its prompt only on auto-trigger (touches models/services/config/migrations, or 3+ files) |
| Feature | Same | Architecture concern always emphasized in the prompt |
| Refactor | Same | Architecture concern always emphasized + explicit behavior-preservation focus (before/after test parity, not just "enough new tests") |
| Investigate-and-Respond | Separate, lightweight **Response Quality** check | Not diff-based — does the draft address what was actually asked/reported, tone, no claims that weren't verified |
| Monitoring Digest | Lightweight **completeness check** | Did it actually query every in-scope platform/repo |

Type-specific nuance is expressed as **prompt-tailoring of one reviewer**, not separate specialized agents.

## 8. Worktree Isolation

- **Every code-change task — manual or automatic — runs in its own git worktree.** No exceptions.
- Use the native `EnterWorktree`/`ExitWorktree` tooling first, raw `git worktree add` only as fallback.
- **Mechanically**: `Workflow` scripts have no filesystem access and `isolation: 'worktree'` is per-`agent()`-call, not per-workflow-run. One setup `agent()` call creates the worktree and returns its path; every subsequent call gets the path threaded explicitly into its prompt.
- **Cleanup policy**: keep the worktree alive while its PR is open and potentially still receiving review-driven commits. Remove once the PR is merged or closed. Keep indefinitely on outright failure/abandonment, for debugging.
- **Gitignored files (notably `CLAUDE.md`) are NOT present in a fresh worktree** — git worktree creation only checks out tracked files. Any prompt needing `CLAUDE.md` must point at the original checkout path (`projectPath`), never the worktree path.

## 9. Knowledge Store — four layers, not two

| Layer | Lives | Loaded how | Covers | Write-owner |
|---|---|---|---|---|
| `CLAUDE.md` | each repo's own root (verify gitignore status per repo, don't assume) | **Automatic** for interactive Claude Code sessions working in that directory; **NOT automatic** for `Workflow`-tool subagents — must be explicitly read (Section 6) | Architecture, commands, codebase mechanisms | Automated Knowledge Save (direct write, private file — Section 19); the user directly |
| Per-directory Claude memory | `.claude\projects\<hash>\memory\*.md` | Live pointer computed from the repo's checkout path, read explicitly | Settled decisions, resolved investigations, standing feedback — accumulated organically by *interactive* sessions | Interactive sessions only (deliberately not written to by automated workflows, to keep this signal clean) |
| `projects\<repo>.md` | `<dataDir>\projects\` | Live pointer, read explicitly | Process/ops facts `CLAUDE.md` doesn't cover: Linear project, ticket/branch policy, infra-migration status, recent gotchas. Also where a given deployment's own implementation history/validation log lives, e.g. `projects\<framework-name>.md` for this framework's own build notes | Automated Knowledge Save (direct write); `/my-assistant-task` Phase 12; manual `/my-assistant-save` |
| `index.md` | `<dataDir>\` | Live pointer, read explicitly | Cross-cutting, non-repo-specific (shared guidelines, standing preferences, project pointers) | Same as above, rare per-task |
| `base-knowledge.md` | `<dataDir>\` | Not read by workflows at all | The user's own cross-project narrative journal (spans non-code projects too) | `/my-assistant-update`, `/my-assistant-save` |

**Deliberately not merged**: `projects\<repo>.md` and `CLAUDE.md` are separate on purpose (same repo, seemingly overlapping) — different audiences (private framework tooling vs. anyone working in the repo), different write-owners (an unattended job vs. potentially a team), different lifecycles (evolving automation state vs. durable architecture).

**Structured DB (e.g. SQLite) remains deferred** to Phase 2, alongside webhooks/hosting.

**Write protection**: a short-lived, project-scoped write-lock around the actual append operation, separate from the code-change repo-lock (Section 11).

## 10. Checkpoint / State Tracking

A separate structured state file per concern (JSON, not markdown), grouped under `<dataDir>\state\`: `routine-state.json` (per-platform, per-repo checkpoints), `kill-switch.json`, `repo-locks.json`. Kept as three separate files deliberately — not merged into one, because they have different, independent writers (concurrent detector runs each own their own file) and merging would introduce a real race-condition risk that doesn't exist today.

## 11. Concurrency & Deduplication

- **Repo-level lock**: only one code-change workflow runs per repo at a time; a second trigger for the same repo queues.
- **Fingerprint check**: before a trigger starts, compare it against in-flight and recently-completed (~24h) runs on that repo, piggybacking on the same classification-step call (Section 12).

## 12. Classification / Dispatch Step

One cheap `agent()` call per detected event, run by each platform's detector:

```
{
  workflow_type: "bug-fix" | "feature" | "refactor" | "investigate-and-respond" | "no-op",
  warrants_action: bool,
  ticket_status: "existing" | "needs-creation" | "none-needed",
  dedup_match: null | { run_id, note },
  reasoning: string
}
```

Repo identity for dispatch is always derived from the detector's own known repo list (from `config.json`'s `repos`, the `.map((repo) => ...)` closure it's already iterating), never from an agent-echoed identifier — a classification agent's self-reported repo name can drift from the exact format a later lookup expects (e.g. an "owner/repo" form vs. the bare repo name), so the script must own that identity, not trust it back from a prompt response.

## 13. Budget / Cost Controls

Two ceilings, both configured in `state/kill-switch.json`'s `budgets` field: `perRunTokens` (a single dispatched workflow's ceiling) and `dailyAggregateTokens` (not yet enforced anywhere — no mechanism currently accumulates a running total of a day's spend across runs). Every dispatcher reads `budgets.perRunTokens` from the Kill-Switch Check and threads it through as `maxTokens` on each dispatched workflow.

**Near-completion grace**: the per-run ceiling grants a 25% allowance once a workflow's Execute loop has reached its last planned task (i.e., zero tasks remain after the one just finished) — implemented as `overBudget(tasksRemaining)` in all three code-change workflow scripts. Rationale: aborting a run that's already finished, over the ceiling by a marginal amount, discards its entire sunk cost for no benefit — the grace only ever applies once there's nothing left to execute, not as a general loosening of the ceiling mid-run.

Per-run ceiling hit → stop and escalate immediately. Daily ceiling hit → skip remaining triggers for the day, note what was skipped in the next Digest (aspirational until the tracking mechanism exists). Maps onto the `Workflow` tool's `budget.total`/`budget.remaining()` primitive.

## 14. Notifications

Tiered by urgency: time-sensitive events (Sentry incidents, direct Slack mentions) push immediately (a DM to whatever `config.json`'s `notify` field specifies); routine events wait for the next Monitoring Digest.

## 15. Kill-Switch

One state file at `state\kill-switch.json`:

```
{
  "global_enabled": true,
  "repos": { "<repo-name-1>": true, "<repo-name-2>": true },
  "budgets": { "perRunTokens": 2000000, "dailyAggregateTokens": 20000000 }
}
```

Every dispatcher checks this **first**, before doing anything else, and reads `budgets.perRunTokens` to thread through as each dispatched workflow's `maxTokens` (Section 13). Toggled by **directly editing the file**, not via a Slack command. Does not interrupt an already-in-flight run; use `TaskStop` for that.

## 16. Development Guidelines (all configured repos, uniform)

- **Commit format**: `<emoji> <Type>(<TICKET-ID>): <description>`, Type capitalized: Feat=✨ Fix=🐛 Refactor=♻️ Docs=📝 Chore=🔧 Ci=👷 Security=🔒️.
- **PR title**: `[TICKET-ID] Title`, always — a ticket is mandatory on every configured repo.
- **PR description**: Claude's discretion, with a required "Verification" section stating plainly whether it passed cleanly or with a disclosed environment-limitation caveat — never an unqualified "all tests pass" claim when that isn't what happened.
- **No auto-merge PRs, ever.**
- **No automatic Linear status transitions.**
- **Ticket policy**: existing ticket → reuse, never duplicate. No ticket + code-change → create one automatically at Intake. Investigate-and-Respond → no ticket needed.
- **Branch policy**: always the exact `gitBranchName` Linear generates — never an invented name. Follow-up work on the same ticket reuses the same branch/worktree.

## 17. How `/my-assistant-task` Relates to Routines

`/my-assistant-task` (installed from this repo's `skills/`/`commands/` into `.claude` — see Section 20) is the **manual front door** into the same shared workflow scripts (Section 6) that routines invoke automatically — same pipeline, same review mechanism, same Knowledge Save step. The differences are the trigger source and, for Features, a live human in the planning loop instead of the self-interview simulation.

## 18. Security & Credential Handling

PR creation must go exclusively through the GitHub MCP tool (`mcp__github__create_pull_request`) — never `gh` CLI, a raw curl/API call, or any approach that touches git credentials directly (e.g. `git credential fill`), under any circumstance. This is a hard mandate in the Finish prompt of all three code-change workflows and in `/my-assistant-task`, not a stylistic preference — an agent working around a missing `gh` CLI by querying credentials directly is exactly the kind of "seemed reasonable in the moment" shortcut that can put a live credential in plaintext somewhere it shouldn't be, and there's no reliable way to guarantee an agent judges that distinction correctly under pressure every time. Removing the need to ever touch credentials at all is the only fix that doesn't depend on that judgment call.

## 19. Knowledge Save / Feedback Loop

Every code-change workflow ends with a **Knowledge Save phase**, run after a successful Finish, fed the run's own actual results (root cause / spec summary / baseline-coverage notes, plan summary, files changed, review findings) — not "review the conversation" the way the interactive `/my-assistant-save` skill works, since a `Workflow` run has no single conversation to review. It classifies what's worth keeping and writes directly (no confirmation gate — see Section 5's `CLAUDE.md` exception):

1. **`CLAUDE.md`** (main checkout path) — durable codebase-architecture facts, or corrections to something it states wrong or stale.
2. **`projects\<repo>.md`** — process/ops facts specific to this repo within the framework, explicitly told not to duplicate what `CLAUDE.md` now covers.
3. **`index.md`** — only genuinely cross-cutting facts; expected to be rare per task.

Each write checks the target file's current content first, to avoid re-saving what's already there. A run can touch zero, one, two, or three files depending on what's genuinely new.

A **nightly knowledge-consolidation routine** (not yet built) is the planned complement: it would read each repo's per-directory Claude memory, classify entries as durable vs. transient, and promote durable ones into `projects\<repo>.md` — keeping that file complete without needing manual curation, and pruning it if it grows too large. Unlike the per-run Knowledge Save phase, this would never touch `CLAUDE.md` unattended on a schedule — writing there stays tied to an actual completed run with real findings, not a periodic sweep.

## 20. File Layout

Everything is split between a git repo (source of truth for code) and a runtime-data directory (knowledge + state + deployment config), because Claude Code structurally requires skills/commands to live in fixed `.claude` locations to be discoverable, while workflows and knowledge have no such constraint:

```
<repo-root>\                                ← git repo, single source of truth
  skills\{my-assistant,my-assistant-task,my-assistant-save,my-assistant-update}\SKILL.md
  commands\{my-assistant,my-assistant-task,my-assistant-save,my-assistant-update}.md
  workflows\{bug-fix,feature,refactor,investigate-and-respond,monitoring-digest}.workflow.js
  workflows\dispatch\{github,linear,sentry,slack}-detector.workflow.js
  docs\agentic-framework-design.md   ← this file
  install.sh / install.ps1          ← deploys skills\ AND commands\ into .claude\ (no config scaffolding — see README)

~\.claude\commands\*.md          ← installed only, never hand-edited
~\.claude\skills\*\SKILL.md      ← installed only, never hand-edited
~\.claude\my-assistant\config-location   ← the ONE fixed bootstrap path in the whole system - a small pointer file, {"configPath": "<dataDir>/config.json"} - see below

<dataDir>\  (wherever the user chose on first run - no baked-in default)   ← runtime data only: knowledge, state, and deployment config
  config.json                  ← dataDir/memoryDir/projectDirs/sessionsDir/workflowsDir/notify/repos - see README
  base-knowledge.md
  index.md
  projects\<repo-name>.md      ← one per configured repo, plus any framework-specific implementation log
  state\{routine-state,kill-switch,repo-locks}.json
  diffs\<project>-<task>-<date>\
    step-01.diff, ..., RESUME.md
```

**Why the pointer file exists**: `dataDir` is user-chosen and can live anywhere, so it can't itself be the thing every session bootstraps from — something has to live at a genuinely fixed location for that. `~\.claude\my-assistant\config-location` is that one fixed anchor. Every interactive skill's first step checks it: if present, read `configPath` from it, then read `config.json` from there directly, no questions asked; if absent, this is the very first run on this machine — ask the one open-ended question about where the data directory should live, scaffold the full structure above in one shot, and write both `config.json` and the pointer itself.

`Workflow`-tool workflows don't strictly need an "install" step the way skills/commands do — `Workflow`'s `scriptPath` takes an explicit path with no fixed discovery location. They live in the git repo for version-control consistency, not because Claude Code requires it there. Each dispatch/monitoring workflow script resolves its config the same two-step way: first an `agent()` read of the fixed pointer at `~/.claude/my-assistant/config-location` for `configPath`, then a second `agent()` read of that actual `config.json` for `dataDir`, `workflowsDir`, `notify`, and `repos` — since workflow scripts themselves have no filesystem access and can't resolve `~` on their own, but the agent doing each read can. Unlike the interactive skills, a workflow script never bootstraps a missing pointer itself (it has no way to ask a question) — the pointer must already exist from at least one prior interactive skill run before any automated routine can work.

## 21. Real-World Validation

Validation runs, outcomes, and lessons learned for a given deployment belong in that deployment's own `projects\<framework-name>.md` file (Section 9) — not in this design doc, which stays deployment-agnostic.

## 22. Deferred to Phase 2 (explicitly out of scope now)

- Real webhooks in place of polling.
- A hosted backend + UI.
- Migrating the knowledge store to a structured DB (e.g. SQLite).
- Any repo beyond what's currently listed in `config.json`.
- Per-platform or per-workflow-type granularity on the kill-switch (currently global + per-repo only).

These are sequenced last deliberately: Phase 1 needs to generate real usage data before any of them can be designed with real numbers instead of guesses.
