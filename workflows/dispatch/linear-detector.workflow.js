export const meta = {
  name: 'linear-detector',
  description: 'Poll Linear for new events across in-scope projects, classify, dedup, dispatch',
  whenToUse: 'Fires on its own CronCreate schedule (Linear is not highly time-sensitive - moderate cadence)',
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
const WORKFLOWS_DIR = 'C:\\Users\\PC\\Workspace\\my-assistant\\workflows'

// workflow('bug-fix', ...) only resolves PRE-REGISTERED workflow names (a separate
// registry from scriptPath files) - these custom workflows aren't registered there, so
// dispatch must go through {scriptPath} instead, or every dispatch throws
// "no workflow with that name".
function workflowScript(name) {
  return { scriptPath: `${WORKFLOWS_DIR}\\${name}.workflow.js` }
}

const REPOS = [
  { name: 'trendy-web', projectPath: 'C:\\Users\\PC\\Workspace\\trendy-web' },
  { name: 'trendy-sdk', projectPath: 'C:\\Users\\PC\\Workspace\\trendy-sdk' },
  { name: 'miswag-pay', projectPath: 'C:\\Users\\PC\\Workspace\\miswag-pay' },
]

phase('Kill-Switch Check')
const killSwitch = await agent(
  `Read ${KILL_SWITCH_PATH} and return its contents. Pure read, no other action.`,
  {
    phase: 'Kill-Switch Check',
    schema: { type: 'object', properties: { global_enabled: { type: 'boolean' }, repos: { type: 'object', additionalProperties: { type: 'boolean' } }, budgets: { type: 'object', properties: { perRunTokens: { type: 'number' } }, required: ['perRunTokens'] } }, required: ['global_enabled', 'repos', 'budgets'] },
  }
)

if (!killSwitch.global_enabled) {
  log('Kill-switch: globally disabled. Exiting without querying Linear.')
  return { status: 'skipped-kill-switch', scope: 'global' }
}

const activeRepos = REPOS.filter((r) => killSwitch.repos[r.name] !== false)
if (activeRepos.length === 0) {
  log('Kill-switch: all in-scope repos disabled.')
  return { status: 'skipped-kill-switch', scope: 'all-repos' }
}

phase('Detect')
const detected = await parallel(
  activeRepos.map((repo) => async () => {
    const result = await agent(
      `Repo/Linear project context: ${repo.name} (trendy-web and trendy-sdk share the "Trendy Loyalty Program" Linear project - check ${PROJECTS_DIR}\\${repo.name}.md for which project applies).

Read the "linear" -> "${repo.name}" entry from ${STATE_PATH} for the last-checked cursor.

Query Linear for anything new since that cursor relevant to this repo's project: new comments/mentions on tickets Ahmed is involved in, tickets newly assigned to Ahmed, status changes on tickets tied to this repo. Update the cursor in ${STATE_PATH} regardless of findings.

Return new events found (empty array if none), each with the ticket ID, URL, type, and enough context to classify without re-fetching. Do NOT try to format the repo identifier yourself - it's added by the caller.`,
      {
        label: `linear-detect:${repo.name}`,
        phase: 'Detect',
        schema: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ticketId: { type: 'string' }, url: { type: 'string' }, type: { type: 'string' }, summary: { type: 'string' }, fullContext: { type: 'string' } },
                required: ['ticketId', 'url', 'type', 'summary', 'fullContext'],
              },
            },
          },
          required: ['events'],
        },
      }
    )
    return result ? { ...result, repoName: repo.name } : null
  })
)

const allEvents = detected.filter(Boolean).flatMap((d) => d.events.map((e) => ({ ...e, repo: d.repoName })))

if (allEvents.length === 0) {
  log('No new Linear events across any in-scope repo.')
  return { status: 'no-events' }
}

phase('Classify & Dispatch')
const results = []

for (const event of allEvents) {
  const repoMeta = activeRepos.find((r) => r.name === event.repo)

  const locks = await agent(
    `Read ${LOCKS_PATH} and return the entry for repo "${event.repo}" only.`,
    { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { locked: { type: 'boolean' }, recent_runs: { type: 'array', items: { type: 'object' } } }, required: ['locked', 'recent_runs'] } }
  )

  const classification = await agent(
    `Linear event on ${event.repo}, ticket ${event.ticketId}: ${event.summary}
Full context: ${event.fullContext}
Recently completed/in-flight work on this repo (dedup): ${JSON.stringify(locks.recent_runs)}

This event is ALREADY tied to ticket ${event.ticketId} - fetch its gitBranchName field directly, ticket_status is "existing", never "needs-creation" here (Linear-originated events always already have a ticket).

Classify: workflow_type (bug-fix/feature/refactor/investigate-and-respond/no-op), warrants_action, dedup_match against recent_runs above (or null), reasoning.`,
    {
      phase: 'Classify & Dispatch',
      schema: {
        type: 'object',
        properties: {
          workflow_type: { type: 'string', enum: ['bug-fix', 'feature', 'refactor', 'investigate-and-respond', 'no-op'] },
          warrants_action: { type: 'boolean' },
          git_branch_name: { type: 'string' },
          dedup_match: { type: ['object', 'null'], properties: { run_id: { type: 'string' }, note: { type: 'string' } } },
          reasoning: { type: 'string' },
        },
        required: ['workflow_type', 'warrants_action', 'git_branch_name', 'reasoning'],
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
  if (isCodeChange && locks.locked) {
    results.push({ event: event.url, outcome: 'queued-repo-locked', workflow_type: classification.workflow_type })
    continue
  }

  if (isCodeChange) {
    await agent(`Set repo "${event.repo}"'s "locked" field to true and "locked_by_run" to "${event.ticketId}" in ${LOCKS_PATH}.`, { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
  }

  const dispatchArgs = {
    repo: event.repo,
    projectPath: repoMeta.projectPath,
    ticketId: event.ticketId,
    gitBranchName: classification.git_branch_name,
    taskDescription: classification.reasoning + '\n\nOriginal trigger: ' + event.fullContext,
    maxTokens: killSwitch.budgets.perRunTokens,
  }

  let result
  if (classification.workflow_type === 'investigate-and-respond') {
    result = await workflow(workflowScript('investigate-and-respond'), { repo: event.repo, projectPath: repoMeta.projectPath, platform: 'linear', triggerSummary: event.summary, triggerContext: event.fullContext })
    if (result.status === 'escalate') {
      result = await workflow(workflowScript(result.escalateTo), { ...dispatchArgs, taskDescription: result.context.taskDescription })
    }
  } else {
    result = await workflow(workflowScript(classification.workflow_type), dispatchArgs)
  }

  if (isCodeChange) {
    await agent(
      `Set repo "${event.repo}"'s "locked" field to false in ${LOCKS_PATH}, and append to recent_runs: { run_id: "${event.ticketId}", fingerprint: "${event.summary.replace(/"/g, "'")}", status: "${result.status}", pr_url: "${result.prUrl || ''}", workflow_type: "${classification.workflow_type}" }. Prune entries older than 24 hours.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
    )
  }

  results.push({ event: event.url, outcome: result.status, ticketId: event.ticketId, prUrl: result.prUrl })

  if (result.status === 'needs-human-decision' || result.status === 'blocked' || result.status === 'verification-failed') {
    await agent(
      `Send a Slack DM to Ahmed now: an automatic ${classification.workflow_type} run on ${event.repo} (ticket ${event.ticketId}) needs attention - status "${result.status}", reason: ${result.reason || 'see run details'}. Time-sensitive, don't wait for the digest.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  }
}

return { status: 'done', processed: results.length, results }
