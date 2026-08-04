export const meta = {
  name: 'monitoring-digest',
  description: 'Read-only daily rollup across GitHub/Linear/Sentry/Slack for all in-scope repos',
  whenToUse: 'Fires on its own daily schedule, not event-triggered',
  phases: [
    { title: 'Gather' },
    { title: 'Synthesize' },
    { title: 'Publish' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

// args: { repos: [{ name, projectPath }], knowledgeIndexPath }
// No worktree, no code changes, no adversarial review - this is pure reporting.

const REPOS = A.repos

phase('Gather')
const perRepo = await parallel(
  REPOS.map((repo) => async () =>
    agent(
      `Repo: ${repo.name}, at ${repo.projectPath}

Gather a status snapshot for the last 24 hours:
- GitHub: open PRs still awaiting review (flag any open >48h), any new CI failures, any new bot/human review comments not yet replied to.
- Linear: tickets assigned to Ahmed that changed status or got new comments.
- Sentry: any new issues (skip if this repo has no Sentry project configured - e.g. trendy-sdk is a library with nothing to report errors).
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
  )
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

1. Send this digest as a Slack DM to Ahmed.
2. Update the "Recent Monitoring Digest rollups" section of ${A.knowledgeIndexPath} - replace its placeholder/previous content with this digest and today's date, keeping only the single most recent rollup (this is a thin index file, not a log).

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
