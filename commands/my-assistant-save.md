# /my-assistant-save

Save the current session's knowledge to the right place — not just one big journal. Run this before closing the terminal, or anytime you want to checkpoint important progress.

## Step 1: Load configuration

Check if `dataDir` is already known this session. If not: check for a pointer file at `~/.claude/my-assistant/config-location` (resolve `~` to the actual home directory — on Windows this is typically `C:\Users\<username>`).

- **If it exists**: read it for `configPath`, then read that file. Use its `dataDir` field directly — never ask.
- **If it doesn't exist**: this is the very first time any my-assistant skill has run on this machine. Ask exactly one question (`AskUserQuestion` if available, otherwise plain text) — no suggested default, just an open question:

  "Where should your my-assistant data directory live?"

  Once answered, in this order:
  1. Create that directory (`dataDir`) if it doesn't exist yet, along with its full structure: `base-knowledge.md` (empty), `index.md` (a skeleton with empty sections), `projects/`, `state/` (with a starter `kill-switch.json` — `{"global_enabled": true, "repos": {}, "budgets": {"perRunTokens": 2000000, "dailyAggregateTokens": 20000000}}`), `diffs/`.
  2. Resolve the rest automatically, without asking: `memoryDir` → `~/.claude/projects`; `projectDirs` → `[~/claude workspace, ~/Workspace]`.
  3. Write `dataDir`, `memoryDir`, and `projectDirs` into `<dataDir>/config.json`.
  4. Create `~/.claude/my-assistant/config-location` containing `{ "configPath": "<dataDir>/config.json" }`.
  5. Tell the user plainly what was set up and where, and that any of it can be changed just by saying so.

If the user explicitly asks to change a stored value during a session, update `config.json` immediately — don't just acknowledge it verbally and leave the file stale.

## Step 2: Review the current session

Look back through the current conversation and extract everything worth keeping:

- **Tasks completed** — what was built, written, fixed, or decided
- **New context about the user** — preferences, constraints, stack details revealed
- **Decisions made** — architectural, business, or personal choices and their reasoning
- **Problems solved** — the issue and the solution (not the debugging journey)
- **Open items** — things started but not finished, or flagged for later
- **New project information** — repos, features, deadlines, collaborators mentioned

Discard: filler conversation, failed attempts, tool noise, anything already obvious from context.

## Step 3: Classify each finding by kind and route it — don't dump everything into one file

For each item extracted in Step 2, decide where it actually belongs:

- **Was this session's work scoped to one of the agentic framework's repos?** Check `config.json`'s `repos` field (or `<dataDir>\index.md`) for the current list.
  - **Process/ops fact** (Linear project details, ticket/branch policy notes, infra-migration status, a gotcha about how something in *this repo's automation* behaves) → goes into `<dataDir>\projects\<repo>.md`.
  - **Confirmed architecture fact, or a correction to something that repo's `CLAUDE.md` gets wrong or has gone stale on** (e.g. a deploy-target migration `CLAUDE.md` doesn't reflect) → do NOT write directly. `CLAUDE.md` lives in a shared team repo. Instead, draft the proposed diff and show it to the user: "This session confirmed/changed X, which `CLAUDE.md` says Y about — want me to update it?" Only write it if they confirm.
- **Cross-cutting, not repo-specific** (a standing preference, a shared convention that applies across projects) → goes into `index.md` directly.
- **Everything else** — general narrative, non-code projects, anything that doesn't fit the above → goes into `base-knowledge.md`, same as before.

An item can land in more than one place if it's genuinely both (e.g. a new standing preference discovered *while* doing repo-specific work — note it in both `index.md` and, if repo-specific detail matters, `projects\<repo>.md`).

## Step 4: Check for duplicates in each target file

Before writing to any of the files identified in Step 3, read that file's current content.
Do not re-save anything already captured there. Only append genuinely new information.

If nothing new was learned this session across all targets, tell the user and stop — do not write an empty entry anywhere.

## Step 5: Write to each target

**`base-knowledge.md`** — append this block at the end:

```
### Session: <YYYY-MM-DD HH:MM> — <one-line topic summary>

**Tasks completed:**
- <bullet per item>

**Decisions & reasoning:**
- <bullet per item>

**Open items:**
- <bullet per item>

**New context:**
- <bullet per item>

---
```

Also add the current timestamp to the `## Processed Sessions` index at the top of the file
in the format: `manual-save-<YYYY-MM-DD-HHMM>` so future `/my-assistant-update` runs know
this session's insights are already captured and don't duplicate them.

**`projects\<repo>.md`** — append or fold new facts into the relevant existing section (Stack / Conventions / Known gotchas), matching that file's existing style. Don't just tack on a dated session log — this file is meant to read as current-state knowledge, not a journal.

**`index.md`** — append to the relevant existing section (shared dev guidelines / standing preferences / project pointers), same style-matching rule as above.

**`CLAUDE.md`** — only after the user confirms per Step 3. Make the smallest edit that fixes/adds the fact, matching that file's existing section structure and tone — it's meant to read as durable project documentation, not a change log.

## Step 6: Confirm

Tell the user:
- What was saved, broken down by file (e.g. "base-knowledge.md: 2 items, projects\my-repo.md: 1 gotcha, index.md: nothing new")
- What was skipped (already known)
- Any `CLAUDE.md` update that's still pending your confirmation
- Remind them: "Run /my-assistant-save again anytime, or /my-assistant-update to bulk-import past sessions."
