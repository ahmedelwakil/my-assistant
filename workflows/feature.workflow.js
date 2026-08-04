export const meta = {
  name: 'feature',
  description: 'Autonomous Feature workflow: spec (real or simulated grill-me), plan, TDD execution, review, draft PR',
  whenToUse: 'Invoked once a trigger is classified as a Feature/Enhancement',
  phases: [
    { title: 'Spec' },
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
//   spec (optional - if provided, this came from a REAL live brainstorming+grill-me
//         session run in the foreground by /my-assistant-task; if omitted, this
//         workflow was triggered automatically and must self-interview instead,
//         since a backgrounded Workflow run has no live human to interview),
//   approvedPlan (optional - {rootCause, planSummary, planFilePath, tasks} from a
//         prior run of this same workflow that paused after Planning for approval.
//         When present, Spec and Plan are both skipped entirely - this run resumes
//         straight to Execute using the already-approved plan, at near-zero cost
//         for the phases already paid for),
//   maxTokens (per-run budget ceiling, optional)
// }

const PROJECTS_DIR = 'C:\\Users\\PC\\claude workspace\\my-assistant\\projects'
const INDEX_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\index.md'
const PENDING_APPROVALS_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\pending-approvals.json'
const WRITE_LOCK_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\.write.lock'

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

// Wraps a shared-state-file write instruction with a simple lock-file mutex, since
// concurrent detectors/resumes could otherwise race on the same JSON file. Not truly
// atomic (this is an LLM following prose, not a real compare-and-swap) but narrows the
// window meaningfully versus no coordination at all.
function guardedWrite(instruction) {
  return `Before doing the write below, guard against a concurrent writer: check if ${WRITE_LOCK_PATH} exists. If absent, create it now containing the current timestamp, then proceed immediately. If present, read its timestamp - if older than 60 seconds treat it as abandoned (a crashed run), overwrite it with the current timestamp, and proceed; otherwise wait ~5 seconds and re-check, up to 6 times, then proceed anyway rather than hanging indefinitely (note in your report if you had to do this). Then: ${instruction} Finally, delete ${WRITE_LOCK_PATH}.`
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

phase('Spec')
let spec
if (A.approvedPlan) {
  log(`Resuming ${A.ticketId} with a pre-approved plan - skipping Spec entirely.`)
  spec = { specDetail: '(skipped - resuming from a pre-approved plan; see the original Linear comment for the spec/investigation)', source: 'resumed-from-approval' }
} else if (A.spec) {
  log('Using spec provided by a live brainstorming + grill-me session (manual invocation).')
  spec = { specDetail: A.spec, source: 'live-grill-me' }
} else {
  log('No live spec provided (automatic trigger) - running a self-interview simulation instead.')
  spec = await agent(
    `Task: ${A.taskDescription}
Ticket: ${A.ticketId}

This is a Feature/Enhancement, triggered automatically (no live human available to interview).

First, extract any design decisions the ticket/task description ALREADY answers explicitly (a stated preferred approach, a named technology/format, an explicit constraint) - treat those as pre-resolved, don't re-litigate them, just record each with a citation to where the ticket said so.

Then follow the grill-me skill's actual dependency-walking discipline for whatever is GENUINELY still open: identify the remaining design decisions, walk them one at a time in dependency order, and for EACH one, propose your own recommended answer using project conventions and best judgment, then resolve it yourself before moving to the next. Document your reasoning for every resolved question as you would in a real grill-me transcript - this becomes part of the eventual PR description so a human can see exactly what was decided and why.

Also follow brainstorming's discipline for the parts of this that are genuinely about constructing the spec (not just auditing it): consider 2-3 possible approaches before committing to one, and be explicit about the tradeoff you chose. Don't apply this ceremony to decisions already pre-resolved from the ticket.

Return the full resolved spec - both the pre-resolved decisions (with their source) and the walked questions with your answers.`,
    {
      phase: 'Spec',
      schema: {
        type: 'object',
        properties: {
          specDetail: { type: 'string' },
          resolvedQuestions: { type: 'array', items: { type: 'string' } },
        },
        required: ['specDetail', 'resolvedQuestions'],
      },
    }
  )
  spec.source = 'self-interview-simulation'
}

phase('Setup')
const setup = await agent(
  `${orientationContext()}

Set up an isolated git worktree for this Feature task.
Repo: ${A.repo}, at ${A.projectPath}
Branch: ${A.gitBranchName} - use this EXACT branch name, never invent one.

Follow the using-git-worktrees skill, but skip its own discovery step - the path to check is exactly ${A.projectPath}\\.worktrees\\${A.gitBranchName}:
1. If that path already exists (a follow-up on the same ticket), use EnterWorktree to enter and reuse it.
2. If it doesn't exist, use EnterWorktree to create it fresh; fall back to raw \`git worktree add\` only if EnterWorktree is unavailable.
Don't run broader exploratory checks (listing all worktrees, scanning repo state) beyond confirming that one specific path.
${
  A.approvedPlan
    ? `\nThis run is resuming a previously-paused ticket now approved for execution. Also update its "Pending Execution Approval" entry in ${INDEX_PATH} - find the entry for ${A.ticketId}, change its status to "in progress - executing".`
    : ''
}

Return the absolute worktree path and whether it was newly created.`,
  {
    phase: 'Setup',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: { worktreePath: { type: 'string' }, created: { type: 'boolean' } },
      required: ['worktreePath', 'created'],
    },
  }
)

log(`Worktree ready at ${setup.worktreePath} (created: ${setup.created}, spec source: ${spec.source})`)

if (overBudget()) {
  return { status: 'aborted-budget', reason: 'Exceeded per-run token ceiling during spec/setup', ticketId: A.ticketId, worktreePath: setup.worktreePath }
}

let plan
if (A.approvedPlan) {
  plan = A.approvedPlan
} else {
  phase('Plan')
  plan = await agent(
    `${orientationContext()}

Working directory: ${setup.worktreePath}

Before planning, run \`git log --oneline\` against this branch's base to check for existing commits (this worktree may be a reused one from prior work on this ticket). If any exist, read what each one actually did (\`git show <sha>\`) and account for that already-completed work - don't re-plan or duplicate it, only plan what's genuinely still needed. If something about the existing work conflicts with or is superseded by a better decision from this Spec, say so explicitly in the plan rather than silently overwriting it.

Spec:
${spec.specDetail}

Invoke the writing-plans skill to produce a rigorous implementation plan: assume zero codebase context, 2-5 minute tasks, exact file paths, real code (never "similar to Task N" placeholders). Save the plan to disk per the skill's own convention - it stays there as the source of truth for exact code/diffs.

Task granularity: 2-5 minutes of focused work is the default size, but each task also carries a fixed execution ceremony cost (fresh-implementer framing, review pass, red/green cycle) regardless of how small it is - so group closely-related, mechanically-similar changes (e.g. the same kind of accessor added to two sibling models) into ONE task rather than splitting them just to stay under 5 minutes. Split into separate tasks only when the pieces are genuinely independent or touch unrelated concerns.

For EACH task, also classify its verification strategy - default to "local-tdd" and only deviate when there's a concrete, nameable reason, never for convenience:
- "local-tdd": the normal case - a failing test can be written and actually run right here, right now, to prove the fix.
- "ci-only": a real test can be written test-first, but red/green confirmation isn't possible in THIS environment (e.g. a missing PHP extension, a service only reachable from CI/staging) - name the specific gap in verificationNotes.
- "manual": no automated test meaningfully covers this (e.g. exact visual output, third-party behavior outside your control) - describe in verificationNotes exactly how a human should verify it.

Also, post a comment on the Linear ticket ${A.ticketId} (use the Linear MCP tool) with a genuinely useful summary of the spec and the plan - not just "see plan file," since that file isn't visible from Linear. Mention explicitly that this run pauses here for manual approval before any code gets written.

Then record a "Pending Execution Approval" entry in ${INDEX_PATH} under a "## Pending Execution Approval" section (create the section if it doesn't exist yet): ticket ID, repo, workflow type ("Feature"), one-line plan summary, worktree path, plan file path, and status "awaiting approval". This is a human-readable pointer only.

Separately, ${guardedWrite(`read ${PENDING_APPROVALS_PATH}, and under the "${A.repo}" array append (or replace an existing entry with the same ticketId) an object with the FULL structured data needed to actually resume this run later without re-planning: { ticketId: "${A.ticketId}", workflowType: "feature", projectPath: "${A.projectPath}", gitBranchName: "${A.gitBranchName}", planSummary: <the plan summary>, planFilePath: <the saved plan file path>, tasks: <the full task list with id/title/verification/verificationNotes>, status: "awaiting-approval", recordedAt: <current date/time> }. This file is the actual source of truth for resuming - the index.md entry above is just a human-readable pointer to it.`)}

Return a short plan summary, the saved plan file's absolute path, the plan's task list (id, one-line title, verification strategy, and verificationNotes - full implementation detail stays in the file, don't repeat it here), and whether the Linear comment, index.md entry, and pending-approvals.json entry were all completed.`,
    {
      phase: 'Plan',
      schema: {
        type: 'object',
        properties: {
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
          pendingApprovalRecorded: { type: 'boolean' },
        },
        required: ['planSummary', 'planFilePath', 'tasks', 'linearCommentPosted', 'pendingApprovalRecorded'],
      },
    }
  )

  if (overBudget()) {
    return { status: 'aborted-budget', reason: 'Exceeded per-run token ceiling during planning', ticketId: A.ticketId, worktreePath: setup.worktreePath }
  }

  const needsLinearRetry = !plan.linearCommentPosted
  const needsApprovalRetry = !plan.pendingApprovalRecorded
  let linearCommentPosted = plan.linearCommentPosted
  let pendingApprovalRecorded = plan.pendingApprovalRecorded

  if (needsLinearRetry || needsApprovalRetry) {
    log(`Plan phase side-effects incomplete (linearCommentPosted=${plan.linearCommentPosted}, pendingApprovalRecorded=${plan.pendingApprovalRecorded}) - retrying once before pausing.`)
    const retry = await agent(
      `The previous Plan phase for ticket ${A.ticketId} reported these side-effects as NOT completed - retry ONLY what's listed below, do not redo any planning work:
${needsLinearRetry ? `- Post a comment on the Linear ticket ${A.ticketId} (use the Linear MCP tool) with this plan summary: ${plan.planSummary}\n` : ''}${needsApprovalRetry ? guardedWrite(`read ${PENDING_APPROVALS_PATH}, and under the "${A.repo}" array append (or replace an existing entry with the same ticketId) an object with the FULL structured data needed to resume this run later: { ticketId: "${A.ticketId}", workflowType: "feature", projectPath: "${A.projectPath}", gitBranchName: "${A.gitBranchName}", planSummary: ${JSON.stringify(plan.planSummary)}, planFilePath: ${JSON.stringify(plan.planFilePath)}, tasks: ${JSON.stringify(plan.tasks)}, status: "awaiting-approval", recordedAt: <current date/time> }.`) : ''}

Report whether each item you were asked to retry now succeeded.`,
      {
        phase: 'Plan',
        model: 'haiku',
        schema: {
          type: 'object',
          properties: {
            linearCommentPosted: { type: 'boolean' },
            pendingApprovalRecorded: { type: 'boolean' },
          },
          required: ['linearCommentPosted', 'pendingApprovalRecorded'],
        },
      }
    )
    if (needsLinearRetry) linearCommentPosted = retry.linearCommentPosted
    if (needsApprovalRetry) pendingApprovalRecorded = retry.pendingApprovalRecorded
  }

  const warnings = []
  if (!linearCommentPosted) warnings.push('Linear comment could not be posted (even after retry) - the plan/spec summary exists only in the plan file, not visible on the ticket.')
  if (!pendingApprovalRecorded) warnings.push('pending-approvals.json entry could not be written (even after retry) - this ticket cannot be resumed via the normal approval flow; manual intervention is needed to record the plan state before approving.')

  return {
    status: warnings.length > 0 ? 'plan-ready-pending-approval-with-warnings' : 'plan-ready-pending-approval',
    ticketId: A.ticketId,
    repo: A.repo,
    worktreePath: setup.worktreePath,
    planFilePath: plan.planFilePath,
    planSummary: plan.planSummary,
    tasks: plan.tasks,
    ...(warnings.length > 0 ? { warnings } : {}),
    note: 'Paused for manual approval before Execute, per policy. Resume by re-dispatching this workflow with args.approvedPlan set to this result (planSummary/planFilePath/tasks).',
  }
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
      ? `Follow test-driven-development strictly: no production code without a failing test first written and confirmed to fail for the right reason, then confirmed to pass after the fix.`
      : task.verification === 'ci-only'
        ? `Verification strategy for this task: ci-only. Reason (from planning): ${task.verificationNotes}. Still write the test FIRST for design clarity, but you won't get a local red/green confirmation for the stated reason - note that plainly in your report rather than forcing it to pass or skipping the test entirely.`
        : `Verification strategy for this task: manual. Reason (from planning): ${task.verificationNotes}. No automated test meaningfully covers this - implement it, and report the exact steps a human should take to verify it manually.`

  const runTask = (modelOverride) =>
    agent(
      `Working directory: ${setup.worktreePath}
Plan file: ${plan.planFilePath}
Execute ONLY task "${task.id}: ${task.title}" from that plan - read just that task's section (plus any shared architecture/context notes at the top of the file you actually need), not the whole plan blindly.

Invoke the subagent-driven-development skill for this task: fresh Implementer subagent (isolated, zero session history) -> Task Reviewer (spec + quality) -> bounded fix loop (max 5 rounds) -> scoped re-review. No pausing between tasks unless genuinely blocked.
${modelOverride ? `\nThis is a RETRY after the first attempt failed - you've been escalated to a more capable model specifically to get past whatever blocked it. Read the plan task fresh; don't assume the first attempt's partial work was correct.` : ''}

${verificationGuidance}

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
Invoke requesting-code-review. Compare the diff against this branch's actual base (origin/main or origin/master) - not session history.
Spec: ${spec.specDetail}
Plan: ${plan.planSummary}

This is a Feature: explicitly scrutinize structural/architectural decisions (new abstractions, coupling, how this fits the existing codebase's layering), not just correctness - always, regardless of file count.

Report findings categorized Critical / Important / Minor.`,
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

let disputedCritical = []
if (review.findings.length > 0) {
  const addressed = await agent(
    `Working directory: ${setup.worktreePath}
Invoke receiving-code-review to triage and address:
${JSON.stringify(review.findings, null, 2)}

Read fully -> restate -> verify against actual code -> evaluate -> respond. Fix order: blocking/security, simple, complex. Reasoned pushback allowed on Important/Minor. Do NOT override a Critical finding yourself - report it as disputed instead if you'd push back on it.

Report what was fixed, pushed back on (with reasoning), and any disputed Critical findings.`,
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
Invoke verification-before-completion: identify the real proof command, run it FRESH now, confirm the output actually shows success. No claims without current evidence.

${verificationContext}

If the fresh run doesn't cleanly pass, classify why:
- "diff-related": a failure that traces back to this change - a real problem. This blocks the PR, full stop.
- "environment-limitation": a failure/skip caused by something about THIS machine/environment (missing extension, unbuilt assets, missing local service) that is unrelated to the diff - back this with concrete evidence, don't assume it because it's convenient. Should usually match one of the pre-declared gaps above, if any exist - if it doesn't match one, treat it with MORE suspicion, not less.
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
  return { status: 'verification-failed', reason: verified.evidence, failureCause: verified.failureCause, ticketId: A.ticketId, worktreePath: setup.worktreePath }
}

const verifiedWithCaveats = !verified.passed && verified.failureCause === 'environment-limitation'

const finished = await agent(
  `Working directory: ${setup.worktreePath}
Invoke finishing-a-development-branch. In this worktree the only real integration option is "create PR" - never merge locally.

Open the PR using the GitHub MCP tool (mcp__github__create_pull_request) - never gh CLI, never a raw curl/GitHub-API call, and never any approach that involves reading git credentials directly (e.g. git credential fill) under any circumstance. The branch itself can still be pushed via plain git push.

Commit format: "<emoji> <Type>(${A.ticketId}): <description>", Type capitalized. This is a Feat: ✨.

PR title: "[${A.ticketId}] <Title>". In the PR body, include the resolved design questions from the Spec phase (${spec.source === 'self-interview-simulation' ? 'this was a self-interview simulation - say so explicitly and list what was resolved' : spec.source === 'resumed-from-approval' ? 'this run resumed from a previously-approved plan - refer to the Linear ticket comment for the original spec/investigation' : 'this came from a live grill-me session'}), so a human reviewer can see exactly what was decided and why, not just the diff. Also include a "Verification" section${
    verifiedWithCaveats
      ? ` stating explicitly and without softening: the fresh local verification run did NOT exit clean - here is why: ${verified.evidence} - and that this is believed to be an environment limitation, not a defect, per that evidence. State plainly that CI/staging is the real verification gate for the affected part(s) of this change. Do not claim "all tests pass."`
      : ` confirming the fresh, real command run and its passing result: ${verified.command} - ${verified.evidence}.`
  }

Open the PR as READY FOR REVIEW, not draft - draft PRs skip this repo's automated appsec-ai-review, so opening ready lets that actually run. Never merge under any circumstance, regardless of draft status - that decision always belongs to a human. Do NOT remove the worktree - keep it while the PR is open.

Return the PR URL.`,
  {
    phase: 'Verify & Finish',
    model: 'haiku',
    schema: { type: 'object', properties: { prUrl: { type: 'string' } }, required: ['prUrl'] },
  }
)

phase('Knowledge Save')
const knowledgeSave = await agent(
  `This Feature for ${A.ticketId} on ${A.repo} just finished.
Spec summary: ${spec.specDetail.slice(0, 2000)}
Plan summary: ${plan.planSummary}
Files changed: ${filesChanged.join(', ')}
Review findings: ${review.findings.length}${review.findings.length > 0 ? ' - ' + JSON.stringify(review.findings) : ''}
PR: ${finished.prUrl}

Classify anything worth remembering from this run and write it directly to the correct file below - no confirmation needed, all three are private (CLAUDE.md is gitignored in this repo, never shared):

1. ${A.projectPath}\\CLAUDE.md - durable facts about how the CODEBASE actually works: a design invariant, an architecture/mechanism detail you discovered (e.g. "X only works via Y, not Z"), or a correction to something CLAUDE.md currently states wrong or stale. This is the kind of fact that would help any engineer or agent understand this codebase - not specific to this automation.
2. ${PROJECTS_DIR}\\${A.repo}.md - process/ops facts specific to working on this repo within this framework: a new gotcha, an infra-migration status change, a convention not yet captured. Do NOT duplicate anything now correctly covered by CLAUDE.md.
3. ${INDEX_PATH} - only if something genuinely cross-cutting came up (a standing preference, a shared convention change) - rare for a single task; most learnings belong in #2 instead.

Before writing to any file, read its current content first and do not re-save anything already captured - only append genuinely new information, matching each file's existing style and section structure (fold into the right section, don't just tack on a dated log entry). If nothing from this run is actually new or worth keeping in a given file, don't touch that file - it's fine to update zero, one, two, or three files depending on what's genuinely new.
${
  A.approvedPlan
    ? `\nThis ticket has a "Pending Execution Approval" entry in ${INDEX_PATH} - find it and update its status to reflect this final outcome (e.g. "done - PR opened: ${finished.prUrl}"), rather than leaving it stuck at "in progress". Also, ${guardedWrite(`read ${PENDING_APPROVALS_PATH} and remove the entry for ticketId "${A.ticketId}" from the "${A.repo}" array entirely (its job is done - the index.md entry above is the permanent human-readable record now).`)}`
    : ''
}

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
  specSource: spec.source,
  reviewFindingsCount: review.findings.length,
  knowledgeSave: knowledgeSave.summary,
  ...(verifiedWithCaveats ? { verificationCaveat: verified.evidence } : {}),
}
