export const meta = {
  name: 'slack-detector',
  description: 'Poll Slack for new DMs/mentions relevant to in-scope work, classify, dedup, dispatch',
  whenToUse: 'Fires on its own CronCreate schedule (Slack is time-sensitive - short cadence)',
  phases: [
    { title: 'Kill-Switch Check' },
    { title: 'Detect' },
    { title: 'Classify & Dispatch' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

const STATE_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\routine-state.json'
const LOCKS_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\repo-locks.json'
const KILL_SWITCH_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\kill-switch.json'
const PROJECTS_DIR = 'C:\\Users\\PC\\claude workspace\\my-assistant\\projects'
const WRITE_LOCK_PATH = 'C:\\Users\\PC\\claude workspace\\my-assistant\\state\\.write.lock'
const WORKFLOWS_DIR = 'C:\\Users\\PC\\Workspace\\my-assistant\\workflows'

// workflow('bug-fix', ...) only resolves PRE-REGISTERED workflow names (a separate
// registry from scriptPath files) - these custom workflows aren't registered there, so
// dispatch must go through {scriptPath} instead, or every dispatch throws
// "no workflow with that name".
function workflowScript(name) {
  return { scriptPath: `${WORKFLOWS_DIR}\\${name}.workflow.js` }
}

// Wraps a shared-state-file write instruction with a simple lock-file mutex, since
// multiple detectors (GitHub/Linear/Sentry/Slack, each on its own cron schedule) could
// otherwise race writing the SAME routine-state.json/repo-locks.json file at once. Not
// truly atomic (this is an LLM following prose, not a real compare-and-swap) but
// narrows the window meaningfully versus no coordination at all.
function guardedWrite(instruction) {
  return `Before doing the write below, guard against a concurrent writer: check if ${WRITE_LOCK_PATH} exists. If absent, create it now containing the current timestamp, then proceed immediately. If present, read its timestamp - if older than 60 seconds treat it as abandoned (a crashed run), overwrite it with the current timestamp, and proceed; otherwise wait ~5 seconds and re-check, up to 6 times, then proceed anyway rather than hanging indefinitely (note in your report if you had to do this). Then: ${instruction} Finally, delete ${WRITE_LOCK_PATH}.`
}

// repo-locks.json only changes when THIS loop itself acquires/releases a lock (no other
// writer runs mid-loop) - so re-reading it fresh for every event on the same repo is pure
// waste (each read costs ~20-30k tokens of fixed agent overhead for a two-line JSON file).
// Cache per repo, invalidate only right after this loop actually writes to it.
const lockCache = {}
async function getLocks(repo) {
  if (!lockCache[repo]) {
    lockCache[repo] = await agent(`Read ${LOCKS_PATH} and return the entry for repo "${repo}" only.`, {
      phase: 'Classify & Dispatch',
      model: 'haiku',
      schema: { type: 'object', properties: { locked: { type: 'boolean' }, recent_runs: { type: 'array', items: { type: 'object' } } }, required: ['locked', 'recent_runs'] },
    })
  }
  return lockCache[repo]
}
function invalidateLocks(repo) {
  delete lockCache[repo]
}

const REPOS = [
  { name: 'trendy-web', projectPath: 'C:\\Users\\PC\\Workspace\\trendy-web' },
  { name: 'trendy-sdk', projectPath: 'C:\\Users\\PC\\Workspace\\trendy-sdk' },
  { name: 'miswag-pay', projectPath: 'C:\\Users\\PC\\Workspace\\miswag-pay' },
]

phase('Kill-Switch Check')
const killSwitch = await agent(
  `Read ${KILL_SWITCH_PATH} and return its contents. Pure read, no other action.`,
  { phase: 'Kill-Switch Check', schema: { type: 'object', properties: { global_enabled: { type: 'boolean' }, repos: { type: 'object', additionalProperties: { type: 'boolean' } }, budgets: { type: 'object', properties: { perRunTokens: { type: 'number' } }, required: ['perRunTokens'] } }, required: ['global_enabled', 'repos', 'budgets'] } }
)

if (!killSwitch.global_enabled) {
  log('Kill-switch: globally disabled. Exiting without querying Slack.')
  return { status: 'skipped-kill-switch', scope: 'global' }
}

const activeRepoNames = REPOS.filter((r) => killSwitch.repos[r.name] !== false).map((r) => r.name)
if (activeRepoNames.length === 0) {
  log('Kill-switch: all in-scope repos disabled.')
  return { status: 'skipped-kill-switch', scope: 'all-repos' }
}

phase('Detect')
// Slack isn't naturally per-repo like GitHub/Linear/Sentry - a DM doesn't belong to a
// specific repo until classified. One global check, not a parallel-per-repo fan-out.
const detection = await agent(
  `Read the "slack" entries from ${STATE_PATH} for the last-checked cursor per repo (use the earliest one across all in-scope repos as the effective cursor, to avoid missing anything).

Check Ahmed's unread DMs and any mentions since that cursor. ${guardedWrite(`update all "slack" cursors in ${STATE_PATH} to reflect this check.`)}

Return each new message with enough context to classify: sender, channel/DM, full text, and your best guess at which of these repos it's about (if any): ${activeRepoNames.join(', ')} - or null if it's unrelated to work entirely (in which case it'll be classified as no-op).`,
  {
    phase: 'Detect',
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              summary: { type: 'string' },
              fullContext: { type: 'string' },
              likelyRepo: { type: ['string', 'null'] },
            },
            required: ['url', 'summary', 'fullContext', 'likelyRepo'],
          },
        },
      },
      required: ['events'],
    },
  }
)

const allEvents = detection.events

if (allEvents.length === 0) {
  log('No new Slack events.')
  return { status: 'no-events' }
}

phase('Classify & Dispatch')
const results = []

for (const event of allEvents) {
  const repoMeta = REPOS.find((r) => r.name === event.likelyRepo)
  const locks = repoMeta ? await getLocks(repoMeta.name) : { locked: false, recent_runs: [] }

  const classification = await agent(
    `Slack message: ${event.summary}
Full context: ${event.fullContext}
Likely repo: ${event.likelyRepo || 'none identified'}
${repoMeta ? `Project notes: ${PROJECTS_DIR}\\${repoMeta.name}.md` : ''}
Recently completed/in-flight work on this repo (dedup, if a repo applies): ${JSON.stringify(locks.recent_runs)}

Most Slack triggers are "investigate-and-respond" (answer a question, give a status update) or "no-op" (not addressed to the assistant, purely social). Only classify as a code-change type (bug-fix/feature/refactor) if Ahmed is genuinely asking for one AND a repo was identified - a code-change workflow cannot run without a repo.

Only classify as warranting action at all if the message is actually DIRECTED at the assistant: a DM, or an explicit @-mention with a real ask. If Ahmed was only cc'd/included as a bystander in a channel thread, or is visibly thinking out loud / talking to someone else without addressing the assistant, that's no-op regardless of topic - being present in a channel isn't the same as being asked to do something.

Classify: workflow_type, warrants_action, ticket_status (existing/needs-creation/none-needed), ticket_id if existing, dedup_match against recent_runs (or null), reasoning.`,
    {
      phase: 'Classify & Dispatch',
      schema: {
        type: 'object',
        properties: {
          workflow_type: { type: 'string', enum: ['bug-fix', 'feature', 'refactor', 'investigate-and-respond', 'no-op'] },
          warrants_action: { type: 'boolean' },
          ticket_status: { type: 'string', enum: ['existing', 'needs-creation', 'none-needed'] },
          ticket_id: { type: ['string', 'null'] },
          git_branch_name: { type: ['string', 'null'] },
          dedup_match: { type: ['object', 'null'], properties: { run_id: { type: 'string' }, note: { type: 'string' } } },
          reasoning: { type: 'string' },
        },
        required: ['workflow_type', 'warrants_action', 'ticket_status', 'reasoning'],
      },
    }
  )

  if (!classification.warrants_action || classification.workflow_type === 'no-op') {
    results.push({ event: event.url, outcome: 'no-op', reasoning: classification.reasoning })
    continue
  }
  if (classification.dedup_match) {
    results.push({ event: event.url, outcome: 'dedup-skipped', matchedRun: classification.dedup_match.run_id })
    continue
  }

  const isCodeChange = ['bug-fix', 'feature', 'refactor'].includes(classification.workflow_type)
  if (isCodeChange && !repoMeta) {
    results.push({ event: event.url, outcome: 'no-op', reasoning: 'Classified as code-change but no repo identified - cannot dispatch.' })
    continue
  }
  if (isCodeChange && locks.locked) {
    results.push({ event: event.url, outcome: 'queued-repo-locked', workflow_type: classification.workflow_type })
    continue
  }

  let ticketInfo = { ticketId: classification.ticket_id, gitBranchName: classification.git_branch_name }
  if (isCodeChange && classification.ticket_status === 'needs-creation') {
    ticketInfo = await agent(
      `Create a new Linear ticket for this Slack-triggered ${classification.workflow_type} on ${repoMeta.name} - use the same Linear project as this repo's other tickets (check ${PROJECTS_DIR}\\${repoMeta.name}.md).
Context: ${event.fullContext}
Return the new ticket's ID and gitBranchName field.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { ticketId: { type: 'string' }, gitBranchName: { type: 'string' } }, required: ['ticketId', 'gitBranchName'] } }
    )
  }

  if (isCodeChange) {
    await agent(guardedWrite(`set repo "${repoMeta.name}"'s "locked" field to true and "locked_by_run" to "${ticketInfo.ticketId || event.url}" in ${LOCKS_PATH}.`), { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
    invalidateLocks(repoMeta.name)
  }

  let result
  if (classification.workflow_type === 'investigate-and-respond') {
    result = await workflow(workflowScript('investigate-and-respond'), {
      repo: event.likelyRepo || 'none',
      projectPath: repoMeta ? repoMeta.projectPath : null,
      platform: 'slack',
      triggerSummary: event.summary,
      triggerContext: event.fullContext,
    })
    if (result.status === 'escalate' && repoMeta) {
      result = await workflow(workflowScript(result.escalateTo), {
        repo: repoMeta.name,
        projectPath: repoMeta.projectPath,
        ticketId: ticketInfo.ticketId,
        gitBranchName: ticketInfo.gitBranchName,
        taskDescription: result.context.taskDescription,
        maxTokens: killSwitch.budgets.perRunTokens,
      })
    }
  } else {
    result = await workflow(workflowScript(classification.workflow_type), {
      repo: repoMeta.name,
      projectPath: repoMeta.projectPath,
      ticketId: ticketInfo.ticketId,
      gitBranchName: ticketInfo.gitBranchName,
      taskDescription: classification.reasoning + '\n\nOriginal Slack message: ' + event.fullContext,
      maxTokens: killSwitch.budgets.perRunTokens,
    })
  }

  if (isCodeChange) {
    await agent(
      guardedWrite(`set repo "${repoMeta.name}"'s "locked" field to false in ${LOCKS_PATH}, and append to recent_runs: { run_id: "${ticketInfo.ticketId || event.url}", fingerprint: "${event.summary.replace(/"/g, "'")}", status: "${result.status}", pr_url: "${result.prUrl || ''}", workflow_type: "${classification.workflow_type}" }. Prune entries older than 24 hours.`),
      { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
    )
    invalidateLocks(repoMeta.name)
  }

  results.push({ event: event.url, outcome: result.status, ticketId: ticketInfo.ticketId, prUrl: result.prUrl })

  // A direct Slack mention/DM is inherently time-sensitive - push immediately, matching Section 14's tiering.
  if (result.status === 'drafted-response') {
    await agent(
      `Send a Slack DM to Ahmed now: a drafted reply to a Slack message is ready for review (not sent automatically). Draft: ${result.draftText}. Reply to this DM with approval or edits before it goes out.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  } else if (result.status === 'plan-ready-pending-approval') {
    await agent(
      `Send a Slack DM to Ahmed now: a Slack-triggered ${classification.workflow_type} run on ${repoMeta.name} (ticket ${ticketInfo.ticketId}) has a plan ready and is paused awaiting your approval before Execute - see the "Pending Execution Approval" section of index.md. Resume it via the resume-approved-plan workflow with { ticketId: "${ticketInfo.ticketId}", repo: "${repoMeta.name}" }.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  } else if (result.status === 'needs-human-decision' || result.status === 'blocked' || result.status === 'verification-failed') {
    await agent(
      `Send a Slack DM to Ahmed now: an automatic ${classification.workflow_type} triggered from Slack needs attention - status "${result.status}", reason: ${result.reason || 'see run details'}.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  }
}

return { status: 'done', processed: results.length, results }
