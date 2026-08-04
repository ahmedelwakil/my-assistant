# /my-assistant-save

Save the current session's knowledge to the right place — not just one big journal. Run this before closing the terminal, or anytime you want to checkpoint important progress.

## Step 1: Locate the base knowledge file

Check if the user has already specified a base knowledge path this session.
If not, ask:

"Where is your base knowledge file?
Default: ~/claude workspace/my-assistant/base-knowledge.md
Press Enter to accept, or type a different path."

Resolve `~` to the actual home directory. On Windows this is typically `C:\Users\<username>`.
Create the directory if it doesn't exist.

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

- **Was this session's work scoped to one of the agentic framework's repos** (trendy-web, trendy-sdk, miswag-pay)? Check `C:\Users\PC\claude workspace\my-assistant\index.md` for the current list.
  - **Process/ops fact** (Linear project details, ticket/branch policy notes, infra-migration status, a gotcha about how something in *this repo's automation* behaves) → goes into `C:\Users\PC\claude workspace\my-assistant\projects\<repo>.md`.
  - **Confirmed architecture fact, or a correction to something that repo's `CLAUDE.md` gets wrong or has gone stale on** (e.g. a deploy-target migration `CLAUDE.md` doesn't reflect) → do NOT write directly. `CLAUDE.md` lives in a shared team repo. Instead, draft the proposed diff and show it to Ahmed: "This session confirmed/changed X, which `CLAUDE.md` says Y about — want me to update it?" Only write it if he confirms.
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

**`CLAUDE.md`** — only after Ahmed confirms per Step 3. Make the smallest edit that fixes/adds the fact, matching that file's existing section structure and tone — it's meant to read as durable project documentation, not a change log.

## Step 6: Confirm

Tell the user:
- What was saved, broken down by file (e.g. "base-knowledge.md: 2 items, projects\trendy-web.md: 1 gotcha, index.md: nothing new")
- What was skipped (already known)
- Any `CLAUDE.md` update that's still pending your confirmation
- Remind them: "Run /my-assistant-save again anytime, or /my-assistant-update to bulk-import past sessions."
