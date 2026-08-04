export const meta = {
  name: 'resume-approved-plan',
  description: 'Resume a paused Feature/Refactor plan (from state/pending-approvals.json) into Execute, with proper repo-lock acquire/release around the mutating phase',
  whenToUse: 'Invoked manually by Ahmed after reviewing a "Pending Execution Approval" entry in index.md and deciding to proceed - args: { ticketId, repo }',
  phases: [
    { title: 'Load' },
    { title: 'Lock Check' },
    { title: 'Execute (resumed)' },
    { title: 'Release & Record' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

// args: { ticketId, repo }

const LOCKS_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\repo-locks.json'
const PENDING_APPROVALS_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\pending-approvals.json'
const KILL_SWITCH_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\kill-switch.json'
const WRITE_LOCK_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\.write.lock'
const WORKFLOWS_DIR = 'C:\\Users\\PC\\Workspace\\my-assistant\\workflows'

// workflow('bug-fix', ...) only resolves PRE-REGISTERED workflow names (a separate
// registry from scriptPath files) - these custom workflows aren't registered there, so
// dispatch must go through {scriptPath} instead, or every dispatch throws
// "no workflow with that name".
function workflowScript(name) {
  return { scriptPath: `${WORKFLOWS_DIR}\\${name}.workflow.js` }
}

// Same mutex convention used by the detectors and by feature/refactor.workflow.js -
// kept duplicated here (not imported) since workflow scripts are self-contained.
function guardedWrite(instruction) {
  return `Before doing the write below, guard against a concurrent writer: check if ${WRITE_LOCK_PATH} exists. If absent, create it now containing the current timestamp, then proceed immediately. If present, read its timestamp - if older than 60 seconds treat it as abandoned (a crashed run), overwrite it with the current timestamp, and proceed; otherwise wait ~5 seconds and re-check, up to 6 times, then proceed anyway rather than hanging indefinitely (note in your report if you had to do this). Then: ${instruction} Finally, delete ${WRITE_LOCK_PATH}.`
}

phase('Load')
const loaded = await agent(
  `Read ${PENDING_APPROVALS_PATH} and find the entry with ticketId "${A.ticketId}" under the "${A.repo}" array.

If it's not there, return found: false and nothing else.
If it is, return found: true and the full entry verbatim (workflowType, projectPath, gitBranchName, planSummary, planFilePath, tasks, baselineCoverageNotes if present).`,
  {
    phase: 'Load',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        entry: {
          type: ['object', 'null'],
          properties: {
            workflowType: { type: 'string', enum: ['feature', 'refactor'] },
            projectPath: { type: 'string' },
            gitBranchName: { type: 'string' },
            planSummary: { type: 'string' },
            planFilePath: { type: 'string' },
            baselineCoverageNotes: { type: ['string', 'null'] },
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
          },
          required: ['workflowType', 'projectPath', 'gitBranchName', 'planSummary', 'planFilePath', 'tasks'],
        },
      },
      required: ['found', 'entry'],
    },
  }
)

if (!loaded.found) {
  log(`No pending-approval entry found for ${A.ticketId} on ${A.repo} - nothing to resume.`)
  return { status: 'not-found', ticketId: A.ticketId, repo: A.repo }
}

const entry = loaded.entry

phase('Lock Check')
const killSwitch = await agent(`Read ${KILL_SWITCH_PATH} and return its "budgets" field only.`, {
  phase: 'Lock Check',
  model: 'haiku',
  schema: {
    type: 'object',
    properties: { budgets: { type: 'object', properties: { perRunTokens: { type: 'number' } }, required: ['perRunTokens'] } },
    required: ['budgets'],
  },
})

const locks = await agent(`Read ${LOCKS_PATH} and return the entry for repo "${A.repo}" only.`, {
  phase: 'Lock Check',
  model: 'haiku',
  schema: {
    type: 'object',
    properties: { locked: { type: 'boolean' } },
    required: ['locked'],
  },
})

if (locks.locked) {
  log(`Repo ${A.repo} is currently locked by another run - not safe to resume ${A.ticketId} right now.`)
  return { status: 'queued-repo-locked', ticketId: A.ticketId, repo: A.repo, note: 'Retry this resume once the current run on this repo finishes.' }
}

await agent(guardedWrite(`set repo "${A.repo}"'s "locked" field to true and "locked_by_run" to "${A.ticketId}" in ${LOCKS_PATH}.`), {
  phase: 'Lock Check',
  model: 'haiku',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
})

phase('Execute (resumed)')
const dispatchArgs = {
  repo: A.repo,
  projectPath: entry.projectPath,
  ticketId: A.ticketId,
  gitBranchName: entry.gitBranchName,
  taskDescription: entry.planSummary,
  maxTokens: killSwitch.budgets.perRunTokens,
  approvedPlan: {
    planSummary: entry.planSummary,
    planFilePath: entry.planFilePath,
    tasks: entry.tasks,
    ...(entry.baselineCoverageNotes ? { baselineCoverageNotes: entry.baselineCoverageNotes } : {}),
  },
}

const result = await workflow(workflowScript(entry.workflowType), dispatchArgs)

phase('Release & Record')
await agent(
  guardedWrite(
    `set repo "${A.repo}"'s "locked" field to false in ${LOCKS_PATH}, and append to recent_runs: { run_id: "${A.ticketId}", fingerprint: "${entry.planSummary.replace(/"/g, "'")}", status: "${result.status}", pr_url: "${result.prUrl || ''}", workflow_type: "${entry.workflowType}" }. Prune entries older than 24 hours.`
  ),
  { phase: 'Release & Record', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
)

if (result.status === 'needs-human-decision' || result.status === 'blocked' || result.status === 'verification-failed') {
  await agent(
    `Send a Slack DM to Ahmed now: the resumed ${entry.workflowType} run on ${A.repo} (ticket ${A.ticketId}) needs attention - status "${result.status}", reason: ${result.reason || 'see run details'}. This was a manually-approved resume, so it's worth flagging promptly rather than waiting for a digest.`,
    { phase: 'Release & Record', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
  )
}

return { status: result.status, ticketId: A.ticketId, repo: A.repo, prUrl: result.prUrl, workflowResult: result }
