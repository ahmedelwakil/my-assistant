export const meta = {
  name: 'bug-fix',
  description: 'Autonomous Bug Fix workflow: worktree, root-cause plan, TDD execution, review, draft PR',
  whenToUse: 'Invoked by a platform dispatcher (or /my-assistant-task) once a trigger is classified as a Bug Fix',
  phases: [
    { title: 'Setup' },
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Review' },
    { title: 'Verify & Finish' },
    { title: 'Knowledge Save' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

// args: {
//   repo, projectPath, ticketId, gitBranchName, taskDescription,
//   maxTokens (per-run budget ceiling, from kill-switch/config - optional)
// }

const PROJECTS_DIR = 'C:\\Users\\PC\\claude workspace\\my-assistant\\projects'
const INDEX_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\index.md'

// tasksRemaining: how many Execute tasks are left AFTER the one just completed.
// When called with 0 (the plan is fully done, nothing left to run), grant a 25%
// grace allowance on the ceiling before aborting - stopping a run that's already
// finished over a marginal overage wastes its entire sunk cost for no benefit.
// Callers outside the Execute loop (Setup/Plan) call this with no argument, which
// keeps the strict ceiling - grace only makes sense once the plan is actually done.
function overBudget(tasksRemaining) {
  if (!A.maxTokens) return false
  const ceiling = tasksRemaining === 0 ? A.maxTokens * 1.25 : A.maxTokens
  return budget.spent() > ceiling
}

// Mirrors Claude Code's own per-working-directory project folder naming, so we can
// point agents at a repo's accumulated session memory (settled decisions, resolved
// investigations, feedback) without maintaining a manual mapping. Silently absent
// for repos with no prior interactive session there - that's expected, not an error.
function claudeMemoryIndexPath(projectPath) {
  return `C:\\Users\\PC\\.claude\\projects\\${projectPath.replace(/[:\\/ ]/g, '-')}\\memory\\MEMORY.md`
}

function orientationContext() {
  return `Before anything else, read these four for orientation - attempt all of them; if one genuinely doesn't exist, note that and move on immediately, it's not a blocker:
1. ${A.projectPath}\\CLAUDE.md - this repo's architecture/commands. Despite living in the repo root, it is NOT automatically in your context here - you must actually read it yourself.
2. ${INDEX_PATH} - cross-cutting shared dev guidelines and standing preferences
3. ${PROJECTS_DIR}\\${A.repo}.md - stack, conventions, known gotchas
4. ${claudeMemoryIndexPath(A.projectPath)} - this repo's own accumulated session memory (settled decisions, resolved investigations, standing feedback); skip silently if it doesn't exist

Treat all four as a starting point to verify against current code, never as ground truth on their own - and treat any infra/deploy-specific claim in CLAUDE.md with a little more suspicion than architectural ones, since nothing currently keeps it in sync automatically when infra changes (e.g. a deploy-target migration).`
}

phase('Setup')
const setup = await agent(
  `${orientationContext()}

Set up an isolated git worktree for this Bug Fix task.
Repo: ${A.repo}, at ${A.projectPath}
Branch: ${A.gitBranchName} - use this EXACT branch name, never invent one.

Follow the using-git-worktrees skill, but skip its own discovery step - the path to check is exactly ${A.projectPath}\\.worktrees\\${A.gitBranchName}:
1. If that path already exists (a follow-up on the same ticket), use EnterWorktree to enter and reuse it.
2. If it doesn't exist, use EnterWorktree to create it fresh; fall back to raw \`git worktree add\` only if EnterWorktree is unavailable.
Don't run broader exploratory checks (listing all worktrees, scanning repo state) beyond confirming that one specific path.

Return the absolute worktree path and whether it was newly created.`,
  {
    phase: 'Setup',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        worktreePath: { type: 'string' },
        created: { type: 'boolean' },
      },
      required: ['worktreePath', 'created'],
    },
  }
)

log(`Worktree ready at ${setup.worktreePath} (created: ${setup.created})`)

phase('Plan')
const plan = await agent(
  `${orientationContext()}

Working directory: ${setup.worktreePath}
Ticket: ${A.ticketId}
Task: ${A.taskDescription}

Before planning, run \`git log --oneline\` against this branch's base to check for existing commits (this worktree may be a reused one from prior work on this ticket). If any exist, read what each one actually did (\`git show <sha>\`) and account for that already-completed work - don't re-plan or duplicate it, only plan what's genuinely still needed.

First, root-cause this using the systematic-debugging skill: reproduce the issue, read the actual error/stack trace, review recent changes via git, and form ONE specific hypothesis before proposing any fix. Do not propose a fix without doing this first.

Once you have a root cause, invoke the writing-plans skill to produce a rigorous implementation plan: assume zero codebase context, break work into 2-5 minute tasks with exact file paths and real code (never "similar to Task N" or other placeholders). Save the plan to disk per the skill's own convention - it stays there as the source of truth for exact code/diffs.

Task granularity: 2-5 minutes of focused work is the default size, but each task also carries a fixed execution ceremony cost (fresh-implementer framing, review pass, red/green cycle) regardless of how small it is - so group closely-related, mechanically-similar changes into ONE task rather than splitting them just to stay under 5 minutes. Split into separate tasks only when the pieces are genuinely independent or touch unrelated concerns.

For EACH task, also classify its verification strategy - default to "local-tdd" and only deviate when there's a concrete, nameable reason, never for convenience:
- "local-tdd": the normal case - a failing test can be written and actually run right here, right now, to prove the fix.
- "ci-only": a real test can be written test-first, but red/green confirmation isn't possible in THIS environment (e.g. a missing PHP extension, a service only reachable from CI/staging) - name the specific gap in verificationNotes.
- "manual": no automated test meaningfully covers this (e.g. exact visual output, third-party behavior outside your control) - describe in verificationNotes exactly how a human should verify it.

Also, post a comment on the Linear ticket ${A.ticketId} (use the Linear MCP tool) with a genuinely useful summary of the root cause and the plan - not just "see plan file," since that file isn't visible from Linear. Do this regardless of what happens next in this run.

Return the root cause summary, a short plan summary, the saved plan file's absolute path, the plan's task list (id, one-line title, verification strategy, and verificationNotes - full implementation detail stays in the file, don't repeat it here), and whether the Linear comment was posted successfully.`,
  {
    phase: 'Plan',
    schema: {
      type: 'object',
      properties: {
        rootCause: { type: 'string' },
        planSummary: { type: 'string' },
        planFilePath: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              verification: { type: 'string', enum: ['local-tdd', 'ci-only', 'manual'] },
              verificationNotes: { type: 'string' },
            },
            required: ['id', 'title', 'verification', 'verificationNotes'],
          },
        },
        linearCommentPosted: { type: 'boolean' },
      },
      required: ['rootCause', 'planSummary', 'planFilePath', 'tasks', 'linearCommentPosted'],
    },
  }
)

if (overBudget()) {
  return { status: 'aborted-budget', reason: 'Exceeded per-run token ceiling during planning', ticketId: A.ticketId, worktreePath: setup.worktreePath }
}

phase('Execute')
const filesChanged = []
let blocker = null
let budgetExceededAfter = null

for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
  const task = plan.tasks[taskIndex]
  const tasksRemainingAfterThis = plan.tasks.length - (taskIndex + 1)
  const verificationGuidance =
    task.verification === 'local-tdd'
      ? `Follow test-driven-development strictly: NO production code without a failing test first written and confirmed to fail for the right reason, then confirmed to pass after the fix.`
      : task.verification === 'ci-only'
        ? `Verification strategy for this task: ci-only. Reason (from planning): ${task.verificationNotes}. Still write the test FIRST for design clarity, but you won't get a local red/green confirmation for the stated reason - note that plainly in your report rather than forcing it to pass or skipping the test entirely.`
        : `Verification strategy for this task: manual. Reason (from planning): ${task.verificationNotes}. No automated test meaningfully covers this - implement it, and report the exact steps a human should take to verify it manually.`

  const runTask = (modelOverride) =>
    agent(
      `Working directory: ${setup.worktreePath}
Plan file: ${plan.planFilePath}
Execute ONLY task "${task.id}: ${task.title}" from that plan - read just that task's section (plus any shared architecture/context notes at the top of the file you actually need), not the whole plan blindly.

Invoke the subagent-driven-development skill for this task: fresh Implementer subagent (isolated, zero session history) -> Task Reviewer (spec + quality) -> bounded fix loop (max 5 rounds) -> scoped re-review.
${modelOverride ? `\nThis is a RETRY after the first attempt failed - you've been escalated to a more capable model specifically to get past whatever blocked it. Read the plan task fresh; don't assume the first attempt's partial work was correct.` : ''}

${verificationGuidance}

If 3 or more fix attempts on the same problem fail, STOP and report that the plan/architecture itself may be wrong rather than trying a 4th variation (per systematic-debugging).

Report: files touched by this task, whether it completed cleanly or hit a blocker, and if blocked, exactly what the blocker is.`,
      {
        label: `execute:${task.id}${modelOverride ? ':retry' : ''}`,
        phase: 'Execute',
        ...(modelOverride ? { model: modelOverride } : {}),
        schema: {
          type: 'object',
          properties: {
            completed: { type: 'boolean' },
            filesChanged: { type: 'array', items: { type: 'string' } },
            blocker: { type: ['string', 'null'] },
          },
          required: ['completed', 'filesChanged', 'blocker'],
        },
      }
    )

  let taskResult = await runTask()
  if (!taskResult.completed) {
    log(`Task ${task.id} failed on first attempt (${taskResult.blocker}) - retrying once with an escalated model before giving up.`)
    taskResult = await runTask('opus')
  }

  filesChanged.push(...taskResult.filesChanged)

  if (!taskResult.completed) {
    blocker = `Task ${task.id} (${task.title}): ${taskResult.blocker} (failed even after escalation retry)`
    break
  }

  if (overBudget(tasksRemainingAfterThis)) {
    budgetExceededAfter = task.id
    break
  }
}

if (blocker) {
  return {
    status: 'blocked',
    reason: blocker,
    ticketId: A.ticketId,
    worktreePath: setup.worktreePath,
    note: 'Worktree left in place for inspection, per failure-handling policy.',
  }
}

if (budgetExceededAfter) {
  return {
    status: 'aborted-budget',
    reason: `Exceeded per-run token ceiling during execution, after task ${budgetExceededAfter}`,
    ticketId: A.ticketId,
    worktreePath: setup.worktreePath,
  }
}

phase('Review')
const review = await agent(
  `Working directory: ${setup.worktreePath}
Invoke the requesting-code-review skill. Compare the diff against this branch's actual base (origin/main or origin/master, detect which this repo uses) - not session history.
Plan that was executed: ${plan.planSummary}
Task: ${A.taskDescription}

This is a Bug Fix: standard review scope. Add an explicit architecture-structure check ONLY if the diff touches models/, services/, config/, migrations/, or spans 3+ files.

Report findings categorized Critical (blocks) / Important (must fix) / Minor (logged).`,
  {
    phase: 'Review',
    schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] },
              summary: { type: 'string' },
              location: { type: 'string' },
            },
            required: ['severity', 'summary'],
          },
        },
      },
      required: ['findings'],
    },
  }
)

const critical = review.findings.filter((f) => f.severity === 'Critical')
const nonCritical = review.findings.filter((f) => f.severity !== 'Critical')

let disputedCritical = []
if (review.findings.length > 0) {
  const addressed = await agent(
    `Working directory: ${setup.worktreePath}
Invoke the receiving-code-review skill to triage and address these findings:
${JSON.stringify(review.findings, null, 2)}

Process: read each finding completely -> restate it in your own words -> verify against the actual code -> evaluate technical soundness -> respond (fix it, or push back with technical reasoning).
Fix order: blocking/security first, then simple fixes, then complex ones.

Legitimate, reasoned pushback is allowed on Important/Minor findings. Do NOT unilaterally override a Critical finding yourself even if you disagree with it - if you would push back on a Critical finding, leave it unresolved and report it as disputed instead, for a human to decide.

Report what was fixed, what was pushed back on (with reasoning), and any disputed Critical findings.`,
    {
      phase: 'Review',
      schema: {
        type: 'object',
        properties: {
          fixed: { type: 'array', items: { type: 'string' } },
          pushedBack: { type: 'array', items: { type: 'string' } },
          disputedCritical: { type: 'array', items: { type: 'string' } },
        },
        required: ['fixed', 'pushedBack', 'disputedCritical'],
      },
    }
  )
  disputedCritical = addressed.disputedCritical
}

if (disputedCritical.length > 0) {
  return {
    status: 'needs-human-decision',
    reason: 'Disputed Critical review finding(s) - not auto-resolved',
    disputedCritical,
    ticketId: A.ticketId,
    worktreePath: setup.worktreePath,
  }
}

phase('Verify & Finish')
const nonStandardVerificationTasks = plan.tasks.filter((t) => t.verification !== 'local-tdd')
const verificationContext =
  nonStandardVerificationTasks.length > 0
    ? `Known, pre-declared verification gaps from planning (not necessarily bugs if exactly these things fail/skip - but verify everything else strictly):
${nonStandardVerificationTasks.map((t) => `- Task ${t.id} (${t.title}): ${t.verification} - ${t.verificationNotes}`).join('\n')}`
    : 'No pre-declared verification gaps - every task was planned as normal local-tdd.'

const verified = await agent(
  `Working directory: ${setup.worktreePath}
Invoke verification-before-completion before anything else: identify the actual proof command for this stack (the real test runner), run it FRESH right now, and confirm the output actually shows success - do not rely on any earlier run or self-report. No tentative language.

${verificationContext}

If the fresh run doesn't cleanly pass, classify why:
- "diff-related": a failure that traces back to this change - a real problem. This blocks the PR, full stop.
- "environment-limitation": a failure/skip caused by something about THIS machine/environment (missing extension, unbuilt assets, missing local service) that is unrelated to the diff - back this with concrete evidence (e.g. git blame showing the failure predates this branch, or directly checking the missing capability), don't assume it because it's convenient. This should usually match one of the pre-declared gaps above, if any exist - if it doesn't match one, treat it with MORE suspicion, not less.
- "unclear": you can't confidently tell which applies - treat this as blocking, same as diff-related, until a human resolves it.
- "none": it passed cleanly.

Only "environment-limitation", backed by concrete evidence, allows this to proceed with the gap disclosed. Everything else blocks.

Return whether it passed, the raw command and result, the failure classification, and the specific evidence for that classification.`,
  {
    phase: 'Verify & Finish',
    schema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        command: { type: 'string' },
        evidence: { type: 'string' },
        failureCause: { type: 'string', enum: ['none', 'diff-related', 'environment-limitation', 'unclear'] },
      },
      required: ['passed', 'command', 'evidence', 'failureCause'],
    },
  }
)

if (!verified.passed && verified.failureCause !== 'environment-limitation') {
  return {
    status: 'verification-failed',
    reason: verified.evidence,
    failureCause: verified.failureCause,
    ticketId: A.ticketId,
    worktreePath: setup.worktreePath,
  }
}

const verifiedWithCaveats = !verified.passed && verified.failureCause === 'environment-limitation'

const finished = await agent(
  `Working directory: ${setup.worktreePath}
Invoke the finishing-a-development-branch skill. In this worktree/detached-HEAD context the only real integration option is "create PR" - always choose that, never merge locally.

Open the PR using the GitHub MCP tool (mcp__github__create_pull_request) - never gh CLI, never a raw curl/GitHub-API call, and never any approach that involves reading git credentials directly (e.g. git credential fill) under any circumstance. The branch itself can still be pushed via plain git push.

Commit message format: "<emoji> <Type>(${A.ticketId}): <description>", Type capitalized. Emoji: Feat=✨ Fix=🐛 Refactor=♻ Docs=📝 Chore=🔧 Ci=👷 Security=🔒. This is a Fix.

PR title: "[${A.ticketId}] <Title>". PR body must include a "Verification" section${
    verifiedWithCaveats
      ? ` stating explicitly and without softening: the fresh local verification run did NOT exit clean - here is why: ${verified.evidence} - and that this is believed to be an environment limitation, not a defect, per that evidence. State plainly that CI/staging is the real verification gate for the affected part(s) of this change. Do not claim "all tests pass."`
      : ` confirming the fresh, real command run and its passing result: ${verified.command} - ${verified.evidence}.`
  }

Open the PR as READY FOR REVIEW, not draft - draft PRs skip this repo's automated appsec-ai-review, so opening ready lets that actually run. Never merge under any circumstance, regardless of draft status - that decision always belongs to a human. Do NOT remove the worktree - it stays alive while the PR is open, only cleaned up once merged or closed.

Return the PR URL.`,
  {
    phase: 'Verify & Finish',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: { prUrl: { type: 'string' } },
      required: ['prUrl'],
    },
  }
)

phase('Knowledge Save')
const knowledgeSave = await agent(
  `This Bug Fix for ${A.ticketId} on ${A.repo} just finished.
Root cause: ${plan.rootCause}
Plan summary: ${plan.planSummary}
Files changed: ${filesChanged.join(', ')}
Review findings: ${review.findings.length}${review.findings.length > 0 ? ' - ' + JSON.stringify(review.findings) : ''}
PR: ${finished.prUrl}

Classify anything worth remembering from this run and write it directly to the correct file below - no confirmation needed, all three are private (CLAUDE.md is gitignored in this repo, never shared):

1. ${A.projectPath}\\CLAUDE.md - durable facts about how the CODEBASE actually works: a design invariant, an architecture/mechanism detail you discovered (e.g. "X only works via Y, not Z"), or a correction to something CLAUDE.md currently states wrong or stale. This is the kind of fact that would help any engineer or agent understand this codebase - not specific to this automation.
2. ${PROJECTS_DIR}\\${A.repo}.md - process/ops facts specific to working on this repo within this framework: a new gotcha, an infra-migration status change, a convention not yet captured. Do NOT duplicate anything now correctly covered by CLAUDE.md.
3. ${INDEX_PATH} - only if something genuinely cross-cutting came up (a standing preference, a shared convention change) - rare for a single task; most learnings belong in #2 instead.

Before writing to any file, read its current content first and do not re-save anything already captured - only append genuinely new information, matching each file's existing style and section structure (fold into the right section, don't just tack on a dated log entry). If nothing from this run is actually new or worth keeping in a given file, don't touch that file - it's fine to update zero, one, two, or three files depending on what's genuinely new.

Report which file(s) you updated and a one-line summary of what was added to each.`,
  {
    phase: 'Knowledge Save',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        claudeMdUpdated: { type: 'boolean' },
        projectsFileUpdated: { type: 'boolean' },
        indexUpdated: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['claudeMdUpdated', 'projectsFileUpdated', 'indexUpdated', 'summary'],
    },
  }
)

return {
  status: verifiedWithCaveats ? 'pr-opened-with-caveats' : 'pr-opened',
  prUrl: finished.prUrl,
  ticketId: A.ticketId,
  worktreePath: setup.worktreePath,
  rootCause: plan.rootCause,
  reviewFindingsCount: review.findings.length,
  knowledgeSave: knowledgeSave.summary,
  ...(verifiedWithCaveats ? { verificationCaveat: verified.evidence } : {}),
}
