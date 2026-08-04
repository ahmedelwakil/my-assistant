export const meta = {
  name: 'github-detector',
  description: 'Poll GitHub for new events across in-scope repos, classify, dedup, dispatch',
  whenToUse: 'Fires on its own CronCreate schedule (GitHub is not highly time-sensitive - moderate cadence)',
  phases: [
    { title: 'Load Config' },
    { title: 'Kill-Switch Check' },
    { title: 'Detect' },
    { title: 'Classify & Dispatch' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

// The data directory itself is user-chosen, so it can't be the fixed bootstrap path - the
// pointer file is. It's the one truly fixed location in the whole system. Workflow scripts
// can't resolve `~` themselves, but the agent doing the read CAN, via its own Bash/Read
// tools, so both paths stay portable across users/platforms instead of hardcoded literals.
const CONFIG_LOCATION_PATH = '~/.claude/my-assistant/config-location'

phase('Load Config')
const configLocation = await agent(
  `Read the file at ${CONFIG_LOCATION_PATH} (resolve "~" to the current user's home directory yourself, e.g. via an environment variable or shell expansion - do not assume a literal path). It's a small JSON file with a single "configPath" field. Return that field's value verbatim.`,
  {
    phase: 'Load Config',
    model: 'haiku',
    schema: { type: 'object', properties: { configPath: { type: 'string' } }, required: ['configPath'] },
  }
)

const config = await agent(
  `Read the config file at ${configLocation.configPath}. Return its "dataDir", "workflowsDir", "notify", and "repos" fields verbatim.`,
  {
    phase: 'Load Config',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        dataDir: { type: 'string' },
        workflowsDir: { type: 'string' },
        notify: { type: 'object', properties: { platform: { type: 'string' }, userName: { type: 'string' } }, required: ['platform', 'userName'] },
        repos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, projectPath: { type: 'string' }, owner: { type: 'string' }, hasSentry: { type: 'boolean' } },
            required: ['name', 'projectPath', 'owner'],
          },
        },
      },
      required: ['dataDir', 'workflowsDir', 'notify', 'repos'],
    },
  }
)

const STATE_PATH = `${config.dataDir}\\state\\routine-state.json`
const LOCKS_PATH = `${config.dataDir}\\state\\repo-locks.json`
const KILL_SWITCH_PATH = `${config.dataDir}\\state\\kill-switch.json`
const PROJECTS_DIR = `${config.dataDir}\\projects`
const WRITE_LOCK_PATH = `${config.dataDir}\\state\\.write.lock`
const WORKFLOWS_DIR = config.workflowsDir

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
    lockCache[repo] = await agent(`Read ${LOCKS_PATH} and return the entry for repo "${repo}" only (locked state + recent_runs array).`, {
      phase: 'Classify & Dispatch',
      model: 'haiku',
      schema: {
        type: 'object',
        properties: { locked: { type: 'boolean' }, recent_runs: { type: 'array', items: { type: 'object' } } },
        required: ['locked', 'recent_runs'],
      },
    })
  }
  return lockCache[repo]
}
function invalidateLocks(repo) {
  delete lockCache[repo]
}

const REPOS = config.repos

phase('Kill-Switch Check')
const killSwitch = await agent(
  `Read ${KILL_SWITCH_PATH} and return its contents as structured data. Do nothing else - this is a pure read, no other action.`,
  {
    phase: 'Kill-Switch Check',
    schema: {
      type: 'object',
      properties: {
        global_enabled: { type: 'boolean' },
        repos: { type: 'object', additionalProperties: { type: 'boolean' } },
        budgets: { type: 'object', properties: { perRunTokens: { type: 'number' } }, required: ['perRunTokens'] },
      },
      required: ['global_enabled', 'repos', 'budgets'],
    },
  }
)

if (!killSwitch.global_enabled) {
  log('Kill-switch: globally disabled. Exiting without querying GitHub.')
  return { status: 'skipped-kill-switch', scope: 'global' }
}

const activeRepos = REPOS.filter((r) => killSwitch.repos[r.name] !== false)
if (activeRepos.length === 0) {
  log('Kill-switch: all in-scope repos disabled. Exiting without querying GitHub.')
  return { status: 'skipped-kill-switch', scope: 'all-repos' }
}

phase('Detect')
const detected = await parallel(
  activeRepos.map((repo) => async () => {
    const result = await agent(
      `Repo: ${repo.owner}/${repo.name}

Read the "github" -> "${repo.name}" entry from ${STATE_PATH} to get the last-checked cursor.

Query GitHub for anything new since that cursor: new review comments (especially bot findings), new PR comments, new failed CI checks on open PRs, PRs newly opened by someone other than the repo owner. Use "updated since" filtering where the API supports it rather than fetching everything and diffing.

${guardedWrite(`update the cursor in ${STATE_PATH} for this repo to reflect this check, regardless of whether anything new was found.`)}

Return the list of new events found (empty array if none), each with enough detail (URL, type, snippet) for a classification step to act on without re-fetching. Do NOT try to format the repo identifier yourself - it's added by the caller.`,
      {
        label: `github-detect:${repo.name}`,
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
                  type: { type: 'string' },
                  summary: { type: 'string' },
                  fullContext: { type: 'string' },
                },
                required: ['url', 'type', 'summary', 'fullContext'],
              },
            },
          },
          required: ['events'],
        },
      }
    )
    // Attach the repo identity from data the script already owns - never trust an
    // agent to echo back an identifier in the exact format needed for a later lookup.
    return result ? { ...result, repoName: repo.name } : null
  })
)

const allEvents = detected.filter(Boolean).flatMap((d) => d.events.map((e) => ({ ...e, repo: d.repoName })))

if (allEvents.length === 0) {
  log('No new GitHub events across any in-scope repo.')
  return { status: 'no-events' }
}

phase('Classify & Dispatch')
const results = []

for (const event of allEvents) {
  const repoMeta = activeRepos.find((r) => r.name === event.repo)

  const locks = await getLocks(event.repo)

  const classification = await agent(
    `Event on ${event.repo}: ${event.summary}
Full context: ${event.fullContext}
Project notes for this repo: read ${PROJECTS_DIR}\\${event.repo}.md for conventions/context if useful.
Recently completed/in-flight work on this repo (for dedup): ${JSON.stringify(locks.recent_runs)}

Known non-actionable patterns - classify as no-op regardless of anything else UNLESS the actual content demonstrates a real, specific problem: a linkback comment that's pure cross-reference to a ticket with no findings, a CI check-run summary with no failures, a bot comment that only restates information already present in the PR description/diff. This is about CONTENT, not authorship - a genuine bot-authored finding (a security scanner actually flagging a vulnerability, a dependency bot flagging an actually-vulnerable dependency, a check that actually failed) is real and actionable regardless of being posted by a bot. Don't let "it's automated" alone justify no-op, and don't let "it's just a linkback" alone justify action - read what it actually says.

Classify this event:
1. workflow_type: one of "bug-fix", "feature", "refactor", "investigate-and-respond", or "no-op" (e.g. a bot comment already fully addressed, or noise not worth acting on).
2. warrants_action: should anything actually happen.
3. ticket_status: "existing" (this event is already tied to a Linear ticket - find its ID and gitBranchName), "needs-creation" (a code-change type with no ticket yet), or "none-needed" (investigate-and-respond/no-op).
4. dedup_match: compare against the recent_runs listed above - does this event describe the same underlying issue as something already in-flight or recently completed? If so return that run's id and a short note; otherwise null.
5. reasoning: brief justification.

Return this as one structured object.`,
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

  if (isCodeChange && locks.locked) {
    results.push({ event: event.url, outcome: 'queued-repo-locked', workflow_type: classification.workflow_type })
    continue
  }

  let ticketInfo = { ticketId: classification.ticket_id, gitBranchName: classification.git_branch_name }
  if (classification.ticket_status === 'needs-creation') {
    ticketInfo = await agent(
      `Create a new Linear ticket for this ${classification.workflow_type} on ${event.repo} - use the same Linear project as this repo's other tickets (check ${PROJECTS_DIR}\\${event.repo}.md).
Context: ${event.fullContext}
Reasoning: ${classification.reasoning}
Return the new ticket's ID and its gitBranchName field.`,
      {
        phase: 'Classify & Dispatch',
        schema: { type: 'object', properties: { ticketId: { type: 'string' }, gitBranchName: { type: 'string' } }, required: ['ticketId', 'gitBranchName'] },
      }
    )
  }

  if (isCodeChange) {
    await agent(
      guardedWrite(`set repo "${event.repo}"'s "locked" field to true and "locked_by_run" to "${ticketInfo.ticketId || event.url}" in ${LOCKS_PATH}.`),
      { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
    )
    invalidateLocks(event.repo)
  }

  const dispatchArgs = {
    repo: event.repo,
    projectPath: repoMeta.projectPath,
    ticketId: ticketInfo.ticketId,
    gitBranchName: ticketInfo.gitBranchName,
    taskDescription: classification.reasoning + '\n\nOriginal trigger: ' + event.fullContext,
    maxTokens: killSwitch.budgets.perRunTokens,
  }

  let result
  if (classification.workflow_type === 'investigate-and-respond') {
    result = await workflow(workflowScript('investigate-and-respond'), {
      repo: event.repo,
      projectPath: repoMeta.projectPath,
      platform: 'github',
      triggerSummary: event.summary,
      triggerContext: event.fullContext,
    })
    if (result.status === 'escalate') {
      result = await workflow(workflowScript(result.escalateTo), { ...dispatchArgs, taskDescription: result.context.taskDescription })
    }
  } else {
    result = await workflow(workflowScript(classification.workflow_type), dispatchArgs)
  }

  if (isCodeChange) {
    await agent(
      guardedWrite(`set repo "${event.repo}"'s "locked" field to false in ${LOCKS_PATH}, and append an entry to its recent_runs array: { run_id: "${ticketInfo.ticketId || event.url}", fingerprint: "${event.summary.replace(/"/g, "'")}", status: "${result.status}", pr_url: "${result.prUrl || ''}", workflow_type: "${classification.workflow_type}" }. Prune recent_runs entries older than 24 hours.`),
      { phase: 'Classify & Dispatch', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
    )
    invalidateLocks(event.repo)
  }

  results.push({ event: event.url, outcome: result.status, ticketId: ticketInfo.ticketId, prUrl: result.prUrl })

  if (result.status === 'plan-ready-pending-approval') {
    await agent(
      `Send a ${config.notify.platform} DM to ${config.notify.userName} now: an automatic ${classification.workflow_type} run on ${event.repo} (ticket ${ticketInfo.ticketId}) has a plan ready and is paused awaiting approval before Execute - see the "Pending Execution Approval" section of index.md for the plan summary and file path. Resume it (once ready) via the resume-approved-plan workflow with { ticketId: "${ticketInfo.ticketId}", repo: "${event.repo}" }.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  } else if (result.status === 'needs-human-decision' || result.status === 'blocked' || result.status === 'verification-failed') {
    await agent(
      `Send a ${config.notify.platform} DM to ${config.notify.userName} now: an automatic ${classification.workflow_type} run on ${event.repo} (ticket ${ticketInfo.ticketId}) needs attention - status "${result.status}", reason: ${result.reason || 'see run details'}. This is time-sensitive, do not wait for the next digest.`,
      { phase: 'Classify & Dispatch', schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] } }
    )
  }
}

return { status: 'done', processed: results.length, results }
