export const meta = {
  name: 'monitoring-digest',
  description: 'Read-only daily rollup across GitHub/Linear/Sentry/Slack for all in-scope repos',
  whenToUse: 'Fires on its own daily schedule, not event-triggered',
  phases: [
    { title: 'Load Config' },
    { title: 'Gather' },
    { title: 'Synthesize' },
    { title: 'Publish' },
  ],
}

// No worktree, no code changes, no adversarial review - this is pure reporting.

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
  `Read the config file at ${configLocation.configPath}. Return its "dataDir", "notify", and "repos" fields verbatim.`,
  {
    phase: 'Load Config',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        dataDir: { type: 'string' },
        notify: { type: 'object', properties: { platform: { type: 'string' }, userName: { type: 'string' } }, required: ['platform', 'userName'] },
        repos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, projectPath: { type: 'string' }, owner: { type: 'string' }, hasSentry: { type: 'boolean' } },
            required: ['name', 'projectPath'],
          },
        },
      },
      required: ['dataDir', 'notify', 'repos'],
    },
  }
)

const REPOS = config.repos
const KNOWLEDGE_INDEX_PATH = `${config.dataDir}\\index.md`

phase('Gather')
const perRepo = await parallel(
  REPOS.map((repo) => async () => {
    const result = await agent(
      `Repo: ${repo.name}, at ${repo.projectPath}

Gather a status snapshot for the last 24 hours:
- GitHub: open PRs still awaiting review (flag any open >48h), any new CI failures, any new bot/human review comments not yet replied to.
- Linear: tickets assigned to ${config.notify.userName} that changed status or got new comments.
- Sentry: any new issues (skip if this repo has no Sentry project configured).
- Slack: any unanswered DMs/mentions relevant to this repo (skip if not applicable).

If a platform genuinely doesn't apply to this repo (e.g. no Sentry project), say so explicitly rather than silently omitting it - that distinction matters for the completeness check later.

Return a structured summary, not prose.`,
      {
        label: `digest:${repo.name}`,
        phase: 'Gather',
        schema: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            githubItems: { type: 'array', items: { type: 'string' } },
            linearItems: { type: 'array', items: { type: 'string' } },
            sentryItems: { type: 'array', items: { type: 'string' } },
            slackItems: { type: 'array', items: { type: 'string' } },
            skippedPlatforms: { type: 'array', items: { type: 'string' } },
            queryErrors: { type: 'array', items: { type: 'string' } },
          },
          required: ['repo', 'githubItems', 'linearItems', 'sentryItems', 'slackItems', 'skippedPlatforms', 'queryErrors'],
        },
      }
    )
    // Never trust an agent-echoed repo identifier for the completeness check below - it may
    // format it differently than config.json's bare name (e.g. "Miswag/trendy-web" vs.
    // "trendy-web"), which would make every repo look "missing" despite real data being
    // gathered. Always attach identity from the script's own known repo list instead.
    return result ? { ...result, repo: repo.name } : null
  })
)

const gathered = perRepo.filter(Boolean)

phase('Synthesize')
const synthesis = await agent(
  `Per-repo status snapshots gathered:
${JSON.stringify(gathered, null, 2)}

Synthesize this into one concise digest message suitable for a Slack DM. Group by repo, lead with anything that needs attention (stale PRs, new Sentry issues, unanswered mentions) before routine items. Keep it scannable, not exhaustive prose.`,
  {
    phase: 'Synthesize',
    schema: {
      type: 'object',
      properties: { digestText: { type: 'string' } },
      required: ['digestText'],
    },
  }
)

const expectedRepos = REPOS.map((r) => r.name)
const reportedRepos = gathered.map((g) => g.repo)
const missingRepos = expectedRepos.filter((name) => !reportedRepos.includes(name))
const anyQueryErrors = gathered.some((g) => g.queryErrors.length > 0)

if (missingRepos.length > 0 || anyQueryErrors) {
  log(`Completeness check: missing repos = [${missingRepos.join(', ')}], query errors present = ${anyQueryErrors}`)
}

phase('Publish')
const published = await agent(
  `Digest to publish:
${synthesis.digestText}

${missingRepos.length > 0 ? `NOTE: this run could not gather data for: ${missingRepos.join(', ')} - say so explicitly at the top of the digest, do not silently present this as complete.` : ''}
${anyQueryErrors ? `NOTE: some queries errored - list them plainly rather than omitting them.` : ''}

1. Send this digest as a ${config.notify.platform} DM to ${config.notify.userName}.
2. Update the "Recent Monitoring Digest rollups" section of ${KNOWLEDGE_INDEX_PATH} - replace its placeholder/previous content with this digest and today's date, keeping only the single most recent rollup (this is a thin index file, not a log).

Return the Slack message link.`,
  {
    phase: 'Publish',
    schema: {
      type: 'object',
      properties: { slackMessageLink: { type: 'string' } },
      required: ['slackMessageLink'],
    },
  }
)

return {
  status: 'published',
  slackMessageLink: published.slackMessageLink,
  missingRepos,
  anyQueryErrors,
}
