# my-assistant Agentic Framework Design

**Status**: Phase 1 substantially built and validated against real triggers. `CronCreate` wiring intentionally still pending.
**Scope**: Phase 1 only (see "Deferred to Phase 2" at the end).

## Implementation Status (as of 2026-08-04)

| # | Item | Status |
|---|---|---|
| 1 | Two-tier knowledge store (`index.md` + `projects/*.md`) | Done |
| 2 | `state/routine-state.json`, `state/kill-switch.json`, `state/repo-locks.json` | Done. `kill-switch.json` now also carries real `budgets` config (Section 13) |
| 3 | `/my-assistant-task` rewritten in place (Superpowers-native pipeline) | Done, updated for all fixes below |
| 4 | `workflows/{bug-fix,feature,refactor}.workflow.js` | Done, hardened (Section 6), plus a second static-review hardening pass on 2026-08-04 (Section 6) |
| 5 | `workflows/{investigate-and-respond,monitoring-digest}.workflow.js` | Done, not yet tested |
| 6 | `workflows/dispatch/{github,linear,sentry,slack}-detector.workflow.js` + `resume-approved-plan.workflow.js` | Done, `github-detector` tested twice manually (crash pre-fix, clean no-events post-fix). All 5 now also pass a real per-run `maxTokens` value through to dispatched workflows (Section 13) — previously designed but never actually wired |
| 7 | `CronCreate` scheduling for the 5 routine jobs | **Still pending, by deliberate choice** — Feature now has one real, complete run (TRE-271, Section 21); Refactor has had a static code-review hardening pass but still zero live runs (Section 21). Held until Refactor gets a real run too |
| 8 | Git repo (`Workspace\my-assistant`) as single source of truth for skills/commands/workflows | Done (Section 20) |
| 9 | `CLAUDE.md`-aware orientation context, front-loaded in all Setup/Plan prompts | Done, verified via probe agent (Section 9) |
| 10 | Automated Knowledge Save phase (all 3 code-change workflows) | Done. Exercised for real by TRE-271's completed run (Section 21) |
| 11 | GitHub MCP mandate (no `gh` CLI, no raw credential handling) | Done, following a real credential-exposure incident (Section 18) |
| 12 | Nightly knowledge-consolidation routine | **Postponed by explicit decision (2026-08-04)**, not just undesigned-and-waiting — revisit only once `CronCreate` wiring itself is live and generating real per-directory memory volume worth consolidating |

Every item above that says "Done" has been validated by actually reading real run transcripts, not just by the code looking correct — several early assumptions in this document turned out to be wrong on inspection (see Section 9 and Section 21). Treat anything not yet run for real as unproven regardless of how sound it reads.

**Separately confirmed 2026-08-04**: a `Workflow`-tool-spawned subagent (an `agent()` call) can genuinely invoke the `Skill` tool by name and receive real skill content back — tested directly with `superpowers:using-superpowers`, not inferred. This had been flagged as an unverified foundational assumption underpinning every reference to "invoke the `writing-plans` skill" etc. throughout this document; it's now empirically confirmed, not just assumed.

## 1. Vision

Today, `/my-assistant-task` is an interactive, human-paced workflow: Ahmed invokes it, answers a few setup questions, and stays in the loop at every gate. This design **updates `/my-assistant-task` in place** to generalize it into a personal agentic framework — a single point of truth **main agent** that handles both:

- **Manual work**: Ahmed invoking `/my-assistant-task` directly, same as today.
- **Automatic work** ("routines"): the same underlying engine triggered by events from GitHub, Linear, Sentry, and Slack, running unattended.

"Single point of truth" means the **dispatch/orchestration logic is shared** — not that there's literally one polling loop. Manual and automatic paths funnel into the same set of workflow types, the same review mechanism, the same knowledge store. The only real differences are how a task starts and what gates it hits along the way.

## 2. Trigger Mechanism (Phase 1: polling, not webhooks)

- **Five separate `CronCreate`-scheduled jobs**: one per platform (GitHub, Linear, Sentry, Slack) on its own cadence — time-sensitive platforms (Slack, Sentry) poll more frequently than GitHub/Linear — plus one for the **Monitoring Digest** on a daily cadence.
- All five call into the **same shared dispatch logic** (the "single point of truth"). Each detector: fetch new events since last checkpoint → classify each → dedup-check → dispatch.
- Runs entirely inside the existing Claude Code environment — no hosting, no server.
- **Why not real webhooks now**: webhooks require a hosted, publicly reachable backend, which in turn would need a structured (non-local-file) knowledge store as a prerequisite — solving that problem now, before knowing whether the workflows themselves are good, would be premature infrastructure investment.

## 3. Project Scope (Phase 1)

`trendy-web`, `trendy-sdk`, `miswag-pay` — all three treated **identically**, no per-repo exceptions. (miswag-pay's production/payment stakes were considered for a stricter pre-execution gate, but rejected — the no-auto-merge policy plus Ahmed's manual PR review is judged sufficient across all three repos uniformly, since nothing ships without his review regardless of repo.)

## 4. Workflow Taxonomy (5 types)

| Type | Touches code? | Needs worktree? | Needs a ticket? |
|---|---|---|---|
| Bug Fix | Yes | Yes | Yes |
| Feature | Yes | Yes | Yes |
| Refactor | Yes | Yes | Yes |
| Investigate-and-Respond | No (usually) | No | No |
| Monitoring Digest | No | No | No |

**Investigate-and-Respond** can escalate mid-run into one of the three code-change types. Escalation is **parent-mediated**, not a nested `workflow()` call: it returns a structured signal (`{escalate: true, to: 'bug-fix', context: {...}}`), and the dispatcher that invoked it inspects that result and separately calls `workflow('bug-fix', {...})` itself — respecting the `Workflow` tool's one-level-nesting limit.

**Monitoring Digest** is time-driven (fires on a schedule), not event-driven, and produces one rollup rather than N per-event responses. No worktree, no code-change pipeline, no adversarial review agent — just a lightweight completeness check (did it actually query every in-scope platform/repo). Posts as a Slack DM to Ahmed.

**Classifying which of the three code-change types applies is pure LLM judgment, not a rule engine.** The classification step (Section 12) just asks the agent to pick `bug-fix`/`feature`/`refactor`/`investigate-and-respond`/`no-op` with a `reasoning` field — nothing further distinguishes the three. In practice: Bug Fix = something is broken relative to intended behavior; Feature = new capability that didn't exist before; Refactor = restructuring existing code without changing external behavior or adding capability. As of this writing, Refactor has never actually run, not even once — no real ticket has been framed clearly enough as behavior-preserving restructuring to test it.

## 5. Supervision Policy: "Propose, don't act"

Auto-triggered tasks investigate, plan, execute, and self-review **fully autonomously** — but always stop before anything externally visible or hard-to-reverse: open the PR as a **draft**, never merge; draft a reply, never send unreviewed.

**Exception — Feature/Enhancement gets an earlier gate**: Feature workflows stop *before execution starts*, not just before merge:
- **Manual invocation**: a real, live `grill-me` session with Ahmed.
- **Automatic trigger**: a **self-interview simulation** — walks the same dependency-ordered decisions `grill-me` would, resolving each itself and documenting the reasoning in the eventual draft PR. Before running the full self-interview ceremony, it first extracts whatever the ticket already answers explicitly (a stated preferred approach, a named format, an explicit constraint) and treats those as pre-resolved — only walking what's genuinely still open. This meaningfully cuts Spec-phase cost on well-specified tickets (see Section 21's TRE-271 data).

**One deliberate exception to "propose, don't act": `CLAUDE.md`.** It's confirmed gitignored and untracked in all three repos (verified via `git check-ignore` + `git ls-files`), meaning it's genuinely private, never seen by a team — so the Knowledge Save phase (Section 19) writes to it directly, no confirmation gate. This isn't a relaxation of the policy; the policy is about not acting on anything *externally visible*, and a gitignored file isn't.

## 6. The Development Pipeline (Bug Fix / Feature / Refactor)

Composed of installed Superpowers skills, wrapped in orchestration logic hardened by real test runs (Section 21):

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

**Orientation is front-loaded and mandatory, not appended.** Every Setup and Plan prompt opens with an explicit, numbered instruction to read four things before anything else: the repo's own `CLAUDE.md` (main checkout path, not the worktree — see below), `index.md`, `projects\<repo>.md`, and the repo's per-directory Claude memory (`.claude\projects\<hash>\memory\MEMORY.md`, computed from the working directory path, present only for repos with prior interactive sessions there). This wasn't the original design: an earlier version appended these as a soft "read if present" note at the *end* of the prompt, and a real transcript proved the agent never read any of them — it went straight to code exploration once it had absorbed a large Spec block. Two separate, real bugs compounded this: `CLAUDE.md` was wrongly assumed to auto-load into `Workflow`-tool subagents (that behavior is interactive-session-only), and `CLAUDE.md` is gitignored, so it isn't even checked out into a fresh worktree at all — pointing at the worktree path would find nothing. The fix (explicit required read, main-checkout path, front of prompt) was verified with a cheap, isolated probe agent before being trusted: given the front-loaded prompt, it correctly read and reported one real fact from all four sources, including following the per-directory memory's index to a linked note.

**Setup and Plan check for prior work on the branch before planning.** Since a worktree can be a reused one from earlier work on the same ticket, Plan is instructed to run `git log --oneline` against the branch's base first and read what any existing commits actually did before planning — so a restart doesn't re-plan or duplicate work already committed.

**Plan returns a lightweight task index, not the full plan text.** `writing-plans` still produces the full, code-complete plan (zero-context-assumed, exact file paths, real code) and saves it to disk — that stays the source of truth. Plan's structured return is just `rootCause`/`planSummary`/`planFilePath` plus a `tasks: [{id, title}]` list; Execute reads the file directly per task instead of the whole plan being re-injected into every subsequent prompt. An earlier version returned the full plan text in the structured output and re-pasted it verbatim into Execute's prompt — a real, measured cost driver (a ~15KB spec/plan block dwarfing everything else in the prompt) fixed once actual per-agent token data was inspected.

**Task granularity favors grouping over atomizing.** `writing-plans`' own "2-5 minute tasks" guidance is followed, but with an explicit override: closely-related, mechanically-similar changes (the same kind of accessor on two sibling models, a new file plus its `composer.json` registration plus its test) get grouped into one task rather than split purely to stay under 5 minutes, because each task carries a largely fixed ceremony cost (fresh-Implementer framing, review pass, red/green cycle) regardless of how small the change is — real transcript data showed a trivial one-line-asset task costing nearly as much as a real model-accessor task.

**Execute is a sequential per-task loop, not one atomic call.** Each task gets its own `agent()` call, invoking `subagent-driven-development` (fresh Implementer → Task Reviewer → bounded fix loop, max 5 rounds, escalating model capability on repeated failure → scoped re-review) and `test-driven-development` strictly. Being separate, cached calls means an interruption mid-Execute only loses the in-flight task — completed tasks replay from cache on resume. Every task also carries a **verification strategy**, decided at Plan time and defaulting to `local-tdd`:
- `local-tdd` — the normal case, a failing test can actually be run right here.
- `ci-only` — a real test can be written test-first, but local red/green confirmation isn't possible (a missing PHP extension, a service only reachable from CI) — named explicitly in `verificationNotes`.
- `manual` — no automated test meaningfully covers this; the task reports exact manual verification steps instead.

`systematic-debugging`'s "3+ failed fixes → pause and question the architecture" applies per-task.

**Verify classifies *why* a fresh run doesn't pass cleanly, rather than treating any non-pass as a hard stop.** Given the pre-declared verification-strategy gaps from Plan as grounding context, Verify classifies a failure as `diff-related` (a real problem — blocks, full stop), `environment-limitation` (backed by concrete evidence, e.g. `git blame` showing the failure predates this branch, or a directly-confirmed missing capability — unrelated to the diff), or `unclear` (treated as blocking, same as `diff-related`, until a human resolves it). Only a well-evidenced `environment-limitation` classification lets the run proceed to a PR with the gap explicitly disclosed in the PR body (`status: 'pr-opened-with-caveats'`, distinct from a clean `pr-opened`) — this exists because a real run hit exactly this (TRE-174: missing `ext-imagick` locally, present in both Vapor Docker images) and the alternative was either a false "all tests pass" claim or an indefinitely blocked, otherwise-correct fix.

**Finish only uses the GitHub MCP tool.** `mcp__github__create_pull_request` — never `gh` CLI, a raw curl/API call, or any approach touching git credentials directly (see Section 18 for why this is a hard rule, not a preference).

**Every successful run ends in a Knowledge Save phase** (Section 19).

**Second hardening pass (2026-08-04), found by static line-by-line comparison of the three code-change workflow scripts against each other, no live run involved:**
- Refactor was missing the `overBudget()` check between Setup and Plan that Feature has (Feature checked budget twice - post-Setup and post-Plan; Refactor only had the second). Added.
- Refactor's final return object omitted its own headline field (`baselineCoverageNotes`) - Bug Fix's return includes `rootCause`, Feature's includes `specSource`, Refactor had neither. Added.
- Refactor's (and Feature's) `local-tdd` verification guidance had quietly dropped Bug Fix's "confirmed to fail for the right reason" phrasing - the part of red-green TDD that actually proves a test means what it claims. Restored in both.
- Feature's and Refactor's Plan-phase pause-for-approval never checked whether its own `linearCommentPosted`/`pendingApprovalRecorded` side-effects actually succeeded before declaring the plan ready - a silent-failure risk, since the whole resume mechanism depends on `pending-approvals.json` actually being written. Both now retry once on either failing, and surface a distinct `plan-ready-pending-approval-with-warnings` status (with a `warnings` array) if a retry still doesn't land, instead of a uniform silent success.
- All three scripts' `meta.phases` were missing a `'Knowledge Save'` entry despite all three executing that phase - cosmetic (progress-UI grouping only), fixed for consistency.
- Found in passing, not a Refactor defect: Feature's own resume-hint text referenced a `rootCause` field that doesn't exist anywhere in Feature's schema (a copy-paste leftover from Bug Fix) - corrected.

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
- **Gitignored files (notably `CLAUDE.md`) are NOT present in a fresh worktree** — git worktree creation only checks out tracked files. Any prompt needing `CLAUDE.md` must point at the original checkout path (`A.projectPath`), never the worktree path.

## 9. Knowledge Store — four layers, not two

The original two-tier design (top-tier index + per-project files) turned out to be incomplete once `CLAUDE.md` and Claude Code's own per-directory memory were accounted for. The real model has four layers, with distinct write-owners and distinct loading mechanisms:

| Layer | Lives | Loaded how | Covers | Write-owner |
|---|---|---|---|---|
| `CLAUDE.md` | each repo's own root (gitignored, untracked in all 3 repos) | **Automatic** for interactive Claude Code sessions working in that directory; **NOT automatic** for `Workflow`-tool subagents — must be explicitly read (Section 6) | Architecture, commands, codebase mechanisms | Automated Knowledge Save (direct write, private file — Section 19); Ahmed directly |
| Per-directory Claude memory | `.claude\projects\<hash>\memory\*.md` | Live pointer computed from the repo's checkout path, read explicitly | Settled decisions, resolved investigations, standing feedback — accumulated organically by *interactive* sessions | Interactive sessions only (deliberately not written to by automated workflows, to keep this signal clean) |
| `projects\<repo>.md` | `claude workspace\my-assistant\projects\` | Live pointer, read explicitly | Process/ops facts `CLAUDE.md` doesn't cover: Linear project, ticket/branch policy, infra-migration status, recent gotchas | Automated Knowledge Save (direct write); `/my-assistant-task` Phase 12; manual `/my-assistant-save` |
| `index.md` | `claude workspace\my-assistant\` | Live pointer, read explicitly | Cross-cutting, non-repo-specific (shared guidelines, standing preferences, project pointers) | Same as above, rare per-task |
| `base-knowledge.md` | `claude workspace\my-assistant\` | Not read by workflows at all | Ahmed's own cross-project narrative journal (spans non-code projects too) | `/my-assistant-update`, `/my-assistant-save` |

**Deliberately not merged**: `projects\<repo>.md` and `CLAUDE.md` were briefly considered for merging (same repo, seemingly overlapping purpose) and rejected — different audiences (private framework tooling vs. anyone working in the repo), different write-owners (an unattended job vs. potentially a team), different lifecycles (evolving automation state vs. durable architecture). The one legitimate fix applied was trimming genuine content duplication between them and adding an explicit cross-reference.

**Structured DB (e.g. SQLite) remains deferred** to Phase 2, alongside webhooks/hosting.

**Write protection**: a short-lived, project-scoped write-lock around the actual append operation, separate from the code-change repo-lock (Section 11).

## 10. Checkpoint / State Tracking

A separate structured state file per concern (JSON, not markdown), now grouped under `claude workspace\my-assistant\state\`: `routine-state.json` (per-platform, per-repo checkpoints), `kill-switch.json`, `repo-locks.json`. Kept as three separate files deliberately — not merged into one, because they have different, independent writers (concurrent detector runs each own their own file) and merging would introduce a real race-condition risk that doesn't exist today.

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

Repo identity for dispatch is always derived from the detector's own known repo list (the `.map((repo) => ...)` closure it's already iterating), never from an agent-echoed identifier — an earlier version trusted the classification agent's self-reported repo name and crashed on a mismatched format (`"Miswag/miswag-pay"` vs. the expected `"miswag-pay"`).

## 13. Budget / Cost Controls

Real data now exists, replacing the original placeholder estimates:

| Run | Outcome | Tokens | Duration | Notes |
|---|---|---|---|---|
| TRE-174 (original) | Interrupted mid-Execute (infra event) | ~838k (Setup+Plan+partial Execute) | ~31.5 min | Pre-dates the per-task Execute fix; one atomic Execute call |
| TRE-271 | Paused mid-Execute (manual, for cost review) | ~1.9M through 5 of ~6-8 tasks | ~46.5 min | Pre-dates task-grouping and the Spec short-circuit |
| **TRE-282** | **Complete** — PR opened, clean | **~548k, fully complete run** | **~43.6 min** | Post-fixes: 1 grouped Execute task, clean verification, zero review findings |

TRE-282 is the only fully complete data point with every fix active, and it cost roughly a third of the earlier *incomplete* runs — real evidence the fixes work, not just a plausible-sounding design. TRE-271's completed run (Section 21) added a second Feature-workflow data point.

**Ceilings raised 2026-08-04**: per-run ceiling **2M tokens** (was ~1M), daily aggregate ceiling **20M tokens** (was ~10M) — both roughly doubled given TRE-271 alone used ~1.9M through most of its tasks before the task-grouping/Spec-short-circuit fixes landed, leaving very little headroom under the old ~1M ceiling for a genuinely large ticket even post-fix.

**Near-completion grace**: the per-run ceiling now grants a 25% allowance once a workflow's Execute loop has reached its last planned task (i.e., zero tasks remain after the one just finished) — implemented as `overBudget(tasksRemaining)` in all three code-change workflow scripts. Rationale: aborting a run that's already finished, over the ceiling by a marginal amount, discards its entire sunk cost for no benefit — the grace only ever applies once there's nothing left to execute, not as a general loosening of the ceiling mid-run.

**Wiring status, corrected 2026-08-04**: until today, `maxTokens` was never actually populated anywhere in real dispatch code — every detector's `dispatchArgs` (and `resume-approved-plan.workflow.js`'s) omitted it entirely, meaning `overBudget()` always evaluated to `false` in any real dispatch regardless of what this section claimed. The two ceiling numbers now live as real structured config in `state/kill-switch.json` (`budgets.perRunTokens`, `budgets.dailyAggregateTokens`), and all 5 dispatch-adjacent scripts read `budgets.perRunTokens` from the Kill-Switch Check and thread it through as `maxTokens` on every code-change dispatch. **The per-run ceiling is now genuinely enforced. The daily aggregate ceiling is still not** — no mechanism anywhere accumulates a running total of today's spend across runs (would need a new state field, increment-after-run logic added to all 5 dispatch scripts, and date-rollover handling), and workflow results don't currently even return their own actual token spend for such a total to be built from. This is a real, scoped follow-up, not a one-line fix — flagged here rather than silently left as an implied-but-untrue claim.

Per-run ceiling hit → stop and escalate immediately (still true, now actually reachable in practice). Daily ceiling hit → skip remaining triggers for the day, note what was skipped in the next Digest (still aspirational until the tracking mechanism above exists). Maps onto the `Workflow` tool's `budget.total`/`budget.remaining()` primitive.

## 14. Notifications

Tiered by urgency: time-sensitive events (Sentry incidents, direct Slack mentions) push immediately (Slack DM to Ahmed); routine events wait for the next Monitoring Digest.

## 15. Kill-Switch

One state file at `state\kill-switch.json`:

```
{
  "global_enabled": true,
  "repos": { "trendy-web": true, "trendy-sdk": true, "miswag-pay": true },
  "budgets": { "perRunTokens": 2000000, "dailyAggregateTokens": 20000000 }
}
```

Every dispatcher checks this **first**, before doing anything else, and reads `budgets.perRunTokens` to thread through as each dispatched workflow's `maxTokens` (Section 13). Toggled by **directly editing the file**, not via a Slack command. Does not interrupt an already-in-flight run; use `TaskStop` for that.

## 16. Development Guidelines (all three repos, uniform)

- **Commit format**: `<emoji> <Type>(<TICKET-ID>): <description>`, Type capitalized: Feat=✨ Fix=🐛 Refactor=♻️ Docs=📝 Chore=🔧 Ci=👷 Security=🔒️.
- **PR title**: `[TICKET-ID] Title`, always — a ticket is mandatory on all three repos.
- **PR description**: Claude's discretion, with a required "Verification" section stating plainly whether it passed cleanly or with a disclosed environment-limitation caveat — never an unqualified "all tests pass" claim when that isn't what happened.
- **No auto-merge PRs, ever.**
- **No automatic Linear status transitions.**
- **Ticket policy**: existing ticket → reuse, never duplicate. No ticket + code-change → create one automatically at Intake. Investigate-and-Respond → no ticket needed.
- **Branch policy**: always the exact `gitBranchName` Linear generates — never an invented name. Follow-up work on the same ticket reuses the same branch/worktree.

## 17. How `/my-assistant-task` Relates to Routines

`/my-assistant-task` (`C:\Users\PC\.claude\commands\my-assistant-task.md`, installed from the git repo — see Section 20) is the **manual front door** into the same shared workflow scripts (Section 6) that routines invoke automatically — same pipeline, same review mechanism, same Knowledge Save step. The differences are the trigger source and, for Features, a live human in the planning loop instead of the self-interview simulation.

## 18. Security & Credential Handling

A real incident shaped a hard rule here, not just a preference. During an early Finish-phase run, a subagent needed to create a PR, found `gh` CLI unavailable anywhere on the machine, and queried `git credential fill` directly to find an alternative — surfacing Ahmed's real, live GitHub OAuth token in plaintext in a tool result. It then hardcoded that value into a literal `TOKEN="gho_..."` bash command (correctly blocked by Claude Code's own safety classifier before executing), then self-corrected to a command-substitution form that resolves the credential inline without ever materializing it in a logged command — which succeeded.

Investigation confirmed the token never reached git history, the PR body, or anywhere public — but it sat in plaintext in the subagent's own transcript, which is enough to warrant treating a credential as compromised regardless of narrow exposure. The actual fix wasn't "be more careful with `git credential fill`" (that still requires an agent to correctly judge a subtle distinction under pressure, every time, forever) — it was removing the need to touch credentials at all: reconnecting the GitHub MCP server and mandating `mcp__github__create_pull_request` for every PR-creation step, with `gh` CLI, raw curl/API calls, and any git-credential access explicitly forbidden in the Finish prompt of all three code-change workflows and in `/my-assistant-task`.

## 19. Knowledge Save / Feedback Loop

Every code-change workflow ends with a **Knowledge Save phase**, run after a successful Finish, fed the run's own actual results (root cause / spec summary / baseline-coverage notes, plan summary, files changed, review findings) — not "review the conversation" the way the interactive `/my-assistant-save` skill works, since a `Workflow` run has no single conversation to review. It classifies what's worth keeping and writes directly (no confirmation gate — see Section 5's `CLAUDE.md` exception):

1. **`CLAUDE.md`** (main checkout path) — durable codebase-architecture facts, or corrections to something it states wrong or stale.
2. **`projects\<repo>.md`** — process/ops facts specific to this repo within the framework, explicitly told not to duplicate what `CLAUDE.md` now covers.
3. **`index.md`** — only genuinely cross-cutting facts; expected to be rare per task.

Each write checks the target file's current content first, to avoid re-saving what's already there. A run can touch zero, one, two, or three files depending on what's genuinely new. First exercised for real by TRE-271's completed run (Section 21) — added after TRE-282 had already finished, so TRE-282 predates it.

A **nightly knowledge-consolidation routine** (not yet built) is the planned complement: it would read each repo's per-directory Claude memory, classify entries as durable vs. transient, and promote durable ones into `projects\<repo>.md` — keeping that file complete without needing manual curation, and pruning it if it grows too large. Unlike the per-run Knowledge Save phase, this would never touch `CLAUDE.md` unattended on a schedule — writing there stays tied to an actual completed run with real findings, not a periodic sweep.

## 20. File Layout (actual, not proposed)

The original file layout assumed everything lived under `~/.claude/my-assistant/`. In practice, that path is now dead — everything is split between a git repo (source of truth for code) and a runtime-data directory (knowledge + state), because Claude Code structurally requires skills/commands to live in fixed `.claude` locations to be discoverable, while workflows and knowledge have no such constraint:

```
C:\Users\PC\Workspace\my-assistant\        ← git repo, single source of truth
  skills\{my-assistant,my-assistant-task,my-assistant-save,my-assistant-update}\SKILL.md
  commands\{my-assistant,my-assistant-task,my-assistant-save,my-assistant-update}.md
  workflows\{bug-fix,feature,refactor,investigate-and-respond,monitoring-digest}.workflow.js
  workflows\dispatch\{github,linear,sentry,slack}-detector.workflow.js
  docs\agentic-framework-design.md   ← this file
  install.sh / install.ps1          ← deploys skills\ AND commands\ into .claude\

C:\Users\PC\.claude\commands\*.md          ← installed only, never hand-edited
C:\Users\PC\.claude\skills\*\SKILL.md      ← installed only, never hand-edited

C:\Users\PC\claude workspace\my-assistant\  ← runtime data only: knowledge + state
  base-knowledge.md
  index.md
  projects\{trendy-web,trendy-sdk,miswag-pay}.md
  state\{routine-state,kill-switch,repo-locks}.json
  diffs\<project>-<task>-<date>\
    step-01.diff, ..., RESUME.md
```

`Workflow`-tool workflows don't strictly need an "install" step the way skills/commands do — `Workflow`'s `scriptPath` takes an explicit path with no fixed discovery location. They live in the git repo for version-control consistency, not because Claude Code requires it there.

## 21. Real-World Validation (Phase 1 test results)

Three real, complete end-to-end runs against trendy-web as of this writing:

- **TRE-174** (AVIF/QR-code crash on undecodable partner logos) — the original run was interrupted mid-Execute by an infrastructure event; Execute had actually completed (5 real commits) by the time it was interrupted, discovered only by inspecting the worktree's own git log rather than trusting the workflow's own "stopped" status. Finished via a targeted Review/Verify/Finish-only script. Local verification genuinely failed (missing `ext-imagick`; both Vapor Docker images have it) — classified as a confirmed environment limitation, so PR #282 was opened with the gap explicitly disclosed rather than either blocking indefinitely or falsely claiming a clean pass.
- **TRE-282** (Filament `Notifications\Collection` `TypeError`, a real Sentry incident with 1,100+ events) — fully clean, complete run. Plan's root-cause investigation didn't just implement the ticket's own proposed fix (extend `Collection` + bind it in the container) — it empirically proved that approach doesn't work (Filament instantiates `Collection` via `new` directly inside `Notifications::mount()`, bypassing the container entirely) and that a second candidate (Livewire component alias re-registration) only covers non-admin pages (the admin panel calls the component by literal FQCN, bypassing the alias registry). It landed on the actually-correct fix: a Composer `classmap` override. PR #283, zero review findings, clean verification. ~548k tokens for the fully complete run — see Section 13.
- **TRE-271** (Feature: partner-image fallback mechanism) — paused mid-Execute (5 of ~6-8 tasks committed) for a cost review; relaunched clean after adding prior-work-awareness (Section 6) so it builds on the existing commits instead of re-planning from scratch. **Completed successfully**: merged as PR #284, 248 tests passed. Review caught a real, live bug in the relaunched scope (not hypothetical) - the original `PartnerImageAvailabilityChecker` design cached reachability results via the app's default cache store, which is genuinely shared Redis on Laravel Cloud but silently falls back to the non-shared `file` driver on Vapor (no cache resource exists there at all, per TRE-293) - correctly split that piece out into its own ticket (TRE-306) rather than blocking the simpler, already-complete presence-based fix on it. First real confirmation that Feature's pause-for-approval → manual resume → Execute-to-completion path works end to end, not just in design.

**What's still unproven**: Refactor has had a static code-review hardening pass (Section 6, 2026-08-04) but has never actually run, not even once - no real ticket has been framed clearly enough as behavior-preserving restructuring to test it, and per 2026-08-04 direction this is being deliberately deferred rather than forced. Every real test so far, across all three code-change types, has been a manually-constructed dispatch (hand-built `args`) - the actual detector → classify → dedup → lock → dispatch chain, which is what unattended `CronCreate` automation would actually rely on, has never been exercised end-to-end with the current, fixed workflow code. A live Refactor run remains the one prerequisite for wiring up `CronCreate` (item 7 in the Implementation Status table) that hasn't been met.

## 22. Deferred to Phase 2 (explicitly out of scope now)

- Real webhooks in place of polling.
- A hosted backend + UI.
- Migrating the knowledge store to a structured DB (e.g. SQLite).
- Any repo beyond trendy-web / trendy-sdk / miswag-pay.
- Per-platform or per-workflow-type granularity on the kill-switch (currently global + per-repo only).

These were deliberately sequenced last: Phase 1 needs to generate real usage data before any of them can be designed with real numbers instead of guesses. Section 13 and Section 21 are the beginning of that real data.
