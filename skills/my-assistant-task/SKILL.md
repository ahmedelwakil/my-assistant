# /my-assistant-task

Generalized multi-agent technical task workflow.
Handles bug fixes, and (coming soon) features and refactoring.
Invoked directly or offered by /my-assistant when it detects a technical task.

---

## Phase 0: Task Intake

Identify what was provided:

- **Linear ticket ID** (e.g. `ENG-123`, `TRN-45`) → fetch the full ticket via Linear MCP: title, description, comments, assignee, labels. Use this as the primary task definition.
- **File + line reference** (e.g. `app/Models/Order.php:142`) → read that file and the surrounding context. Use it as the starting point for investigation.
- **Free text description** → ask 1–2 clarifying questions before proceeding if the scope is unclear. Keep it tight — don't over-clarify.

Cross-reference whatever input was given against base knowledge (`~/.claude/my-assistant/base-knowledge.md`) and the relevant per-project config (`~/.claude/my-assistant/projects/<project-name>.md`) to enrich context before planning.

---

## Phase 1: Stack Detection

Auto-detect the project stack from the working directory:

| File found | Stack |
|---|---|
| `composer.json` + `artisan` | Laravel / PHP → test runner: PHPUnit (`./vendor/bin/phpunit`) |
| `package.json` + `jest.config.*` | Node.js → test runner: Jest (`npm test`) |
| `package.json` + `vitest.config.*` | Node.js → test runner: Vitest (`npm run test`) |
| `go.mod` | Go → test runner: `go test ./...` |
| `pyproject.toml` / `requirements.txt` | Python → test runner: pytest |
| `Gemfile` | Ruby → test runner: RSpec or Minitest |

Store detected stack and test runner — all agents use these throughout.

Load per-project config from `~/.claude/my-assistant/projects/<project-name>.md` if it exists.
If no config exists yet, create a skeleton after the task completes.

---

## Phase 2: Task Start Prompts

Use `AskUserQuestion` to collect all configuration in one go. Ask these together:

**Q1 — Supervision mode:**
- 1 · Full Control — gate after every file write, all findings shown
- 2 · Step by Step — gate after each step, critical findings auto-fixed
- 3 · Review Gate — gate when review agents report, you approve fixes
- 4 · Milestone — gate at plan approval + before final commit only
- 5 · Autonomous — gate only on unresolvable conflicts

**Q2 — Linear integration:** (show only if a Linear ticket is in context)
- None — read ticket for context only, no updates
- Status only — move ticket status as task progresses
- Full — status updates + post implementation summary as comment + link commits

**Q3 — Test strategy:**
- Standard — tests written and run as final verification gate
- TDD — Test Writer writes tests first (they run red), implementation makes them green

**Q4 — Architecture review:**
- Auto (recommended) — activate Architecture Agent when files touched include models/, services/, config/, migrations/, or span 3+ files
- Always on — include Architecture Agent regardless
- Skip — no architecture review this task

Store all four answers. Reference them throughout every phase below.

---

## Phase 3: Plan

Main Agent writes a numbered execution plan:

```
Step 1: [action] — intent: [why]
Step 2: [action] — intent: [why]
...
```

Rules:
- Each step must have a single clear intent
- Steps must be ordered by dependency (no step assumes work from a later step)
- Flag any step that touches models/, services/, config/, migrations/ — used for Architecture Agent auto-trigger
- Estimate number of files affected per step

**If TDD mode:** insert a step 0 — "Test Writer Agent writes failing tests for the expected behavior."

**Gate:** always pause here regardless of mode. Show the plan and ask for approval before any code is written. User may edit the plan before confirming.

---

## Phase 4: Execution Loop

Repeat for each step in the approved plan:

### 4a — Baseline snapshot

```bash
# If git is available:
git diff HEAD > ~/.claude/my-assistant/diffs/<project>-<task-slug>-<YYYY-MM-DD>/step-<NN>.diff

# If no git:
# Copy modified files to the diffs directory before writing
```

Create the diffs directory if it doesn't exist.

### 4b — Execute the step

Write code directly to files. Live edits — no showing-then-applying.

Annotations gate: **never add comments, docblocks, or inline documentation** unless:
- The per-project config explicitly requires it, OR
- The user has asked for it in this session

### 4c — TDD check (if TDD mode)

After each implementation step, run the test suite:
```bash
<detected test runner>
```
Show pass/fail. If failing, the Main Agent fixes before proceeding to review agents.

### 4d — Spawn review agents in parallel

Always spawn these two together after each step:

**Intent & Conventions Agent prompt:**
```
Review the diff at ~/.claude/my-assistant/diffs/<project>-<task-slug>-<date>/step-<NN>.diff

Task: <task description or Linear ticket summary>
Project conventions: <loaded from per-project config>
Stack: <detected stack>

Check:
1. Does this implementation match the task intent?
2. Does it follow the project's conventions?
3. Are there any logic errors or edge cases missed?
4. If a Linear ticket exists: does this match the ticket's acceptance criteria?

Report findings as: CRITICAL (must fix) / MINOR (suggest) / PASS
```

**Test Coverage Reviewer Agent prompt:**
```
Review the test cases written for step <NN> of this task.

Diff: ~/.claude/my-assistant/diffs/<project>-<task-slug>-<date>/step-<NN>.diff
Stack / test runner: <detected>

Check:
1. Are the happy path cases covered?
2. Are edge cases and failure modes tested?
3. Are there any obvious gaps in coverage?
4. Are the test descriptions clear and accurate?

Report findings as: CRITICAL (coverage gap) / MINOR (improvement) / PASS
```

**Architecture Agent** (if triggered by auto-detect or user config):
```
Review the diff at ~/.claude/my-assistant/diffs/<project>-<task-slug>-<date>/step-<NN>.diff

Project: <name>, Stack: <detected>
Known architecture from base knowledge: <relevant excerpt>

Check:
1. Does this introduce structural violations or tight coupling?
2. Does it create tech debt inconsistent with the existing codebase?
3. Does it respect the established layering (e.g. no business logic in controllers)?

Report findings as: CRITICAL / MINOR / PASS
```

### 4e — Present findings

Collect all agent reports. Then apply the supervision mode:

| Mode | Behavior |
|---|---|
| 1 — Full Control | Show all findings. Wait for user to approve each fix individually |
| 2 — Step by Step | Auto-fix CRITICAL findings. Show MINOR findings. Gate before next step |
| 3 — Review Gate | Show all findings grouped by agent. User approves fix list. Apply fixes. Gate |
| 4 — Milestone | Auto-fix all findings. Log what was fixed. No gate until final milestone |
| 5 — Autonomous | Auto-fix all findings. Escalate only if agents conflict or fix fails after 2 retries |

### 4f — Apply fixes

Main Agent applies approved or auto-approved fixes directly to files.
Re-run affected review agent(s) once to verify fixes resolved the findings.

### 4g — Step gate

Apply gate per mode before moving to the next step.
In modes 1–3: show a summary of what was done in this step and wait for "continue".
In modes 4–5: proceed automatically.

---

## Phase 5: Final Test Gate

After all steps complete, run the full test suite:
```bash
<detected test runner>
```

If tests fail:
- Auto-retry: Main Agent diagnoses and fixes. Re-run. Up to 2 attempts.
- If still failing after 2 retries: escalate to user regardless of mode. Show the failure output and ask for guidance.

If tests pass: proceed to Phase 6.

---

## Phase 6: Implementation Summary

Compose a summary of what was done:

```
## Task: <title>
**Steps completed:** N
**Files modified:** <list>
**Tests:** <passed / added X new tests>
**Agent findings resolved:** <count critical + minor>

### What changed
<bullet points — one per step, plain language>

### Decisions made
<any non-obvious choices and why>

### Open items
<anything not addressed, follow-up suggestions>
```

---

## Phase 7: Linear Updates (if not "None")

**Status only:** move ticket to the appropriate status (In Review / Done).

**Full:**
1. Post the implementation summary as a comment on the ticket
2. Move ticket status
3. When user commits: include ticket ID in commit message

---

## Phase 8: Commit Gate

Always manual — never auto-commit.

Suggest a commit message:
- With Linear ticket: `[TICKET-ID] <what changed>`
- Without: conventional commit format — `fix:`, `feat:`, `refactor:` etc.

Wait for user to commit. Do not proceed or close the task until the user confirms.

---

## Phase 9: Knowledge Save

After commit (or if user says they're done):

1. Append to `~/.claude/my-assistant/base-knowledge.md`:
   - Task completed, files touched, decisions made, problems solved
2. Update `~/.claude/my-assistant/projects/<project-name>.md`:
   - Any new conventions observed, stack details confirmed, quirks discovered

---

## Failure Handling

**Test failure:** auto-retry up to 2 times. If still failing, escalate regardless of mode.

**Agent conflict** (Intent & Conventions vs Architecture disagree on a fix): escalate immediately. Show both positions and ask user to decide.

**Unrecoverable error** (file write fails, tool error, agent crashes):
1. Stop immediately
2. Run `git diff HEAD` and save to the diffs directory
3. Write a resume report to `~/.claude/my-assistant/diffs/<project>-<task-slug>-<date>/RESUME.md`:
   ```
   Stopped at: Step N — <what was being done>
   Last successful step: N-1
   Files in progress: <list>
   To resume: re-open /my-assistant-task and say "resume <task-slug>"
   ```
4. Tell the user exactly what happened and where the resume report is
