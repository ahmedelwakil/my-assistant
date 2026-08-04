export const meta = {
  name: 'investigate-and-respond',
  description: 'Investigate a trigger and draft a reply/comment (no code change), or signal escalation to a code-change workflow',
  whenToUse: 'Invoked when a trigger warrants investigation and a response but not necessarily a code change',
  phases: [
    { title: 'Investigate' },
    { title: 'Draft' },
    { title: 'Quality Check' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args

// args: {
//   repo, projectPath, platform ('github'|'linear'|'sentry'|'slack'),
//   triggerSummary, triggerContext (the actual comment/issue/message text + link),
// }
//
// Returns EITHER:
//   { status: 'escalate', escalateTo: 'bug-fix'|'feature'|'refactor', context: {...} }
//     - the calling dispatcher is responsible for actually invoking that workflow;
//       this script never calls workflow() itself (one-level nesting limit).
//   { status: 'drafted-response', draftText, needsApproval: true }
//     - drafted only, never posted - "propose, don't act" applies to replies too,
//       since posting a comment/reply is externally visible.

phase('Investigate')
const investigation = await agent(
  `Platform: ${A.platform}
Repo: ${A.repo}
Trigger: ${A.triggerSummary}
Full context: ${A.triggerContext}

Investigate what's actually being asked or reported. If this is a Sentry issue or a bug-shaped GitHub/Linear comment, follow the systematic-debugging skill's Phase 1 (root cause investigation) far enough to know whether this is genuinely a code problem or just a question/misunderstanding.

Decide: does this require an actual code change (a real bug fix, feature, or refactor), or can it be fully addressed with a reply/comment alone?

If it requires a code change, do NOT attempt the fix yourself here - return escalation instead.`,
  {
    phase: 'Investigate',
    schema: {
      type: 'object',
      properties: {
        needsCodeChange: { type: 'boolean' },
        escalateTo: { type: ['string', 'null'], enum: ['bug-fix', 'feature', 'refactor', null] },
        findings: { type: 'string' },
      },
      required: ['needsCodeChange', 'escalateTo', 'findings'],
    },
  }
)

if (investigation.needsCodeChange) {
  return {
    status: 'escalate',
    escalateTo: investigation.escalateTo,
    context: {
      repo: A.repo,
      projectPath: A.projectPath,
      taskDescription: investigation.findings,
      originPlatform: A.platform,
      originTrigger: A.triggerSummary,
    },
  }
}

phase('Draft')
const draft = await agent(
  `Platform: ${A.platform}
Findings from investigation: ${investigation.findings}
Original trigger: ${A.triggerContext}

Draft a reply/comment that directly addresses what was actually asked or reported. Match the tone appropriate to the platform (a GitHub PR review reply is more technical/terse; a Slack reply can be more conversational). Do not claim anything was verified unless it actually was as part of this investigation - no unverified assertions (e.g. don't say "tests pass" if none were run).`,
  {
    phase: 'Draft',
    schema: {
      type: 'object',
      properties: { draftText: { type: 'string' } },
      required: ['draftText'],
    },
  }
)

phase('Quality Check')
const quality = await agent(
  `Original trigger/question: ${A.triggerContext}
Investigation findings: ${investigation.findings}
Drafted response: ${draft.draftText}

Response Quality check - this is NOT a code-diff review, it's reviewing a drafted reply:
1. Does the draft actually address what was asked/reported, not something adjacent?
2. Is the tone appropriate for the platform (${A.platform})?
3. Does it assert anything as fact/verified that wasn't actually confirmed during investigation?

If there's a real problem, revise the draft yourself and return the corrected version.`,
  {
    phase: 'Quality Check',
    schema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        finalDraftText: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['passed', 'finalDraftText', 'notes'],
    },
  }
)

return {
  status: 'drafted-response',
  draftText: quality.finalDraftText,
  needsApproval: true,
  platform: A.platform,
  repo: A.repo,
  qualityNotes: quality.notes,
}
