# /my-assistant-save

Save the current session's knowledge to the base knowledge file.
Run this before closing the terminal, or anytime you want to checkpoint important progress.

## Step 1: Locate the base knowledge file

Check if the user has already specified a base knowledge path this session.
If not, ask:

"Where is your base knowledge file?
Default: ~/.claude/my-assistant/base-knowledge.md
Press Enter to accept, or type a different path."

Resolve `~` to the actual home directory.
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

## Step 3: Check for duplicates

Read the existing base knowledge file.
Do not re-save anything already captured there.
Only append genuinely new information from this session.

If nothing new was learned this session, tell the user and stop — do not write an empty entry.

## Step 4: Append to base knowledge file

Add the following block at the end of the file:

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

## Step 5: Confirm

Tell the user:
- What was saved (a brief summary)
- What was skipped (already known)
- The path of the base knowledge file
- Remind them: "Run /my-assistant-save again anytime, or /my-assistant-update to bulk-import past sessions."
