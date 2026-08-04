export const meta = {
  name: 'sentry-detector',
  description: 'Poll Sentry for new/regressed issues, classify, dedup, dispatch',
  whenToUse: 'Fires on its own CronCreate schedule (Sentry is time-sensitive - short cadence)',
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

// trendy-sdk excluded: it's a library, not a deployed service - nothing reports to Sentry.
const REPOS = [
  { name: 'trendy-web', projectPath: 'C:\\Users\\PC\\Workspace\\trendy-web' },
  { name: 'miswag-pay', projectPath: 'C:\\Users\\PC\\Workspace\\miswag-pay' },
]

phase('Kill-Switch Check')
const killSwitch = await agent(
  `Read ${KILL_SWITCH_PATH} and return its contents. Pure read, no other action.`,
  { phase: 'Kill-Switch Check', schema: { type: 'object', properties: { global_enabled: { type: 'boolean' }, repos: { type: 'object', additionalProperties: { type: 'boolean' } }, budgets: { type: 'object', properties: { perRunTokens: { type: 'number' } }, required: ['perRunTokens'] } }, required: ['global_enabled', 'repos', 'budgets'] } }
)

if (!killSwitch.global_enabled) {
  log('Kill-switch: globally disabled. Exiting without querying Sentry.')
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
      `Repo: ${repo.name}
Read the "sentry" -> "${repo.name}" entry from ${STATE_PATH} for the last-checked cursor.

Query Sentry for anything new/changed since that cursor for this repo's project: newly created issues, issues that regressed (previously resolved, now firing again), issues that crossed a severity/volume threshold worth attention. ${guardedWrite(`update the cursor in ${STATE_PATH} regardless of findings.`)}

Return new events found (empty array if none), each with the Sentry issue URL, type, and enough context (error message, stack trace summary, affected count) to classify without re-fetching. Do NOT try to format the repo identifier yourself - it's added by the caller.`,
      {
        label: `sentry-detect:${repo.name}`,
        phase: 'Detect',
        schema: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: { type: 'object', properties: { url: { type: 'string' }, type: { type: 'string' }, summary: { type: 'string' }, fullContext: { type: 'string' } }, required: ['url', 'type', 'summary', 'fullContext'] },
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
  log('No new Sentry events across any in-scope repo.')
  return { status: 'no-events' }
}

phase('Classify & Dispatch')
const results = []

for (const event of allEvents) {
  const repoMeta = activeRepos.find((r) => r.name === event.repo)

  const locks = await getLocks(event.repo)

  const classification = await agent(
    `Sentry event on ${event.repo}: ${event.summary}
Full context: ${event.fullContext}
Project notes: ${PROJECTS_DIR}\\${event.repo}.md
Recently completed/in-flight work on this repo (dedup): ${JSON.stringify(locks.recent_runs)}

Sentry issues are almost always "bug-fix" (a real error) or "investigate-and-respond" (worth a diagnostic comment/triage before committing to a fix, e.g. if root cause is unclear). Check whether a Linear ticket already exists for this issue; if not and this warrants a code change, ticket_status is "needs-creation".

Exclude as no-op: issues already marked ignored, muted, or resolved-and-not-actually-regressed in Sentry itself (verify the CURRENT status in Sentry directly, don't just trust the event summary) - the detector cursor can occasionally surface something Ahmed already triaged there manually. Everything else that's a genuine new/regressed error warrants at least investigate-and-respond.

Classify: workflow_type, warrants_action, ticket_status, ticket_id (if existing), dedup_match against recent_runs above (or null), reasoning.`,
    {
      phase: 'Classify & Dispatch',
      schema: {
        type: 'object',
        properties: {
          workflow_type: { type: 'string', enum: ['bug-fix', 'investigate-and-respond', 'no-op'] },
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

  const isCodeChange = classification.workflow_type === 'bug-fix'
  if (isCodeChange && locks.locked) {
    results.push({ event: event.url, outcome: 'queued-repo-locked', workflow_type: classification.workflow_type })
    continue
  }

  let ticketInfo = { ticketId: classification.ticket_id, gitBranchName: classification.git_branch_name }
  if (classification.ticket_status === 'needs-creation') {
    ticketInfo = await agent(
      `Create a new Linear ticket for this Sentry-reported bug on ${event.repo} - use the same Linear project as this repo's other tickets (check ${PROJECTS_DIR}\\${event.repo}.md).
Context: ${event.fullContext}
Return the new ticket's ID and gitBranchName field.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { ticketId: { type: 'string' }, gitBranchName: { type: 'string' } }, required: ['ticketId', 'gitBranchName'] } }
    )
  }

  if (isCodeChange) {
    await agent(guardedWrite(`set repo "${event.repo}"'s "locked" field to true and "locked_by_run" to "${ticketInfo.ticketId || event.url}" in ${LOCKS_PATH}.`), { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
    invalidateLocks(event.repo)
  }

  const dispatchArgs = {
    repo: event.repo,
    projectPath: repoMeta.projectPath,
    ticketId: ticketInfo.ticketId,
    gitBranchName: ticketInfo.gitBranchName,
    taskDescription: classification.reasoning + '\n\nOriginal Sentry event: ' + event.fullContext,
    maxTokens: killSwitch.budgets.perRunTokens,
  }

  let result
  if (classification.workflow_type === 'investigate-and-respond') {
    result = await workflow(workflowScript('investigate-and-respond'), { repo: event.repo, projectPath: repoMeta.projectPath, platform: 'sentry', triggerSummary: event.summary, triggerContext: event.fullContext })
    if (result.status === 'escalate') {
      result = await workflow(workflowScript(result.escalateTo), { ...dispatchArgs, taskDescription: result.context.taskDescription })
    }
  } else {
    result = await workflow(workflowScript('bug-fix'), dispatchArgs)
  }

  if (isCodeChange) {
    await agent(
      guardedWrite(`set repo "${event.repo}"'s "locked" field to false in ${LOCKS_PATH}, and append to recent_runs: { run_id: "${ticketInfo.ticketId || event.url}", fingerprint: "${event.summary.replace(/"/g, "'")}", status: "${result.status}", pr_url: "${result.prUrl || ''}", workflow_type: "bug-fix" }. Prune entries older than 24 hours.`),
      { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
    )
    invalidateLocks(event.repo)
  }

  results.push({ event: event.url, outcome: result.status, ticketId: ticketInfo.ticketId, prUrl: result.prUrl })

  // Sentry is always time-sensitive - push immediately regardless of outcome, not just on failure.
  await agent(
    `Send a Slack DM to Ahmed now: a Sentry-triggered ${classification.workflow_type} on ${event.repo} (ticket ${ticketInfo.ticketId || 'n/a'}) finished with status "${result.status}"${result.prUrl ? `, draft PR: ${result.prUrl}` : ''}. Sentry events are always pushed immediately, not batched into the digest.`,
    { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
  )
}

return { status: 'done', processed: results.length, results }
