---
name: my-assistant-update
description: DEPRECATED, do not run. Legacy bulk import of old Claude session transcripts into the single base-knowledge ledger. Kept for reference only; use /my-assistant-save to record knowledge.
---

# /my-assistant-update

> **DEPRECATED (2026-10-27).** The owner used this once for the initial import and retired it. It writes to the frozen legacy ledger `base-knowledge.md`, and its `sessionsDir` default points at a scratchpad folder, not the real transcripts. If invoked, tell the user it is retired, point them to `/my-assistant-save`, and stop unless they explicitly insist. The original instructions are kept below unchanged (mark, don't delete).

Update the base knowledge file for /my-assistant by synthesizing Claude session transcripts.
This command is additive — it never deletes existing knowledge, even if source sessions are gone.

## Step 1: Load configuration

Check for a pointer file at `~/.claude/my-assistant/config-location` (resolve `~` to the actual home directory — on Windows this is typically `C:\Users\<username>`).

- **If it exists**: read it for `configPath`, then read that file. Use its `dataDir` and `sessionsDir` fields directly — never ask about anything already there. If `sessionsDir` specifically is missing (this is the one field only this skill needs that the shared bootstrap doesn't set), ask just for that:

  "Where are your Claude session transcripts (JSONL files)? (Windows is typically `C:\Users\<username>\AppData\Local\Temp\claude`, macOS `~/Library/Caches/claude-code/projects`, Linux/WSL `/tmp/claude` or `~/.local/share/claude`.)"

  Write the answer into `<dataDir>/config.json` under `sessionsDir`, merging into existing content.

- **If it doesn't exist**: this is the very first time any my-assistant skill has run on this machine. Ask exactly one question (`AskUserQuestion` if available, otherwise plain text) — no suggested default, just an open question:

  "Where should your my-assistant data directory live?"

  Once answered, in this order:
  1. Create that directory (`dataDir`) if it doesn't exist yet, along with its full structure: `base-knowledge.md` (empty), `index.md` (a skeleton with empty sections), `projects/`, `state/` (with a starter `kill-switch.json` — `{"global_enabled": true, "repos": {}, "budgets": {"perRunTokens": 2000000, "dailyAggregateTokens": 20000000}}`), `diffs/`.
  2. Resolve the rest automatically, without asking: `memoryDir` → `~/.claude/projects`; `projectDirs` → `[~/claude workspace, ~/Workspace]`.
  3. Ask the `sessionsDir` question above (this skill genuinely can't proceed without it).
  4. Write `dataDir`, `memoryDir`, `projectDirs`, and `sessionsDir` into `<dataDir>/config.json`.
  5. Create `~/.claude/my-assistant/config-location` containing `{ "configPath": "<dataDir>/config.json" }`.
  6. Tell the user plainly what was set up and where, and that any of it can be changed just by saying so.

If the user explicitly asks to change a stored value during a session, update `config.json` immediately — don't just acknowledge it verbally and leave the file stale.

## Step 2: Load existing base knowledge

Read the base knowledge file (if it exists).
Extract the list of already-processed session IDs from the header section `## Processed Sessions`.
These sessions must be skipped — do not re-process them.

If the file does not exist yet, start fresh with an empty processed-sessions list.

## Step 3: Discover session files

List all `.jsonl` files in the sessions directory recursively.
Filter out any whose filename (without extension) appears in the processed-sessions list.
These are the new sessions to process.

If there are no new sessions, tell the user and stop.

## Step 4: Process each new session

For each new JSONL file:

1. Read the file contents.
2. Parse each line as a JSON record. Focus on:
   - `role: "user"` messages — what the user asked or described
   - `role: "assistant"` messages — what Claude answered, built, or decided
   - Tool results that reveal file edits, code written, or commands run
3. Synthesize a compact summary covering:
   - **Topic / goal** of the session (1–2 sentences)
   - **Key decisions or conclusions** reached
   - **Code, files, or features** produced
   - **Problems solved** and how
   - **Context about the user** revealed (role, stack, preferences, constraints)
4. Discard filler, repeated attempts, and tool noise — only keep signal.

Process sessions in batches of 10 to stay within context limits.
After each batch, append findings to the base knowledge file before continuing.

## Step 5: Write to base knowledge file

Append the following block to the base knowledge file for each newly processed session:

```
### Session: <filename-without-extension>
**Date processed:** <today's date>
**Topic:** <1-sentence summary>

<synthesized knowledge — bullet points>

---
```

At the very top of the file (or update the existing header), maintain this index:

```
## Processed Sessions
<!-- DO NOT EDIT THIS SECTION MANUALLY -->
<session-id-1>
<session-id-2>
...
```

This index is how future updates know which sessions are already captured.

## Step 6: Confirm

Tell the user:
- How many new sessions were processed
- How many were skipped (already in base)
- The path where the base knowledge file was saved
- A brief summary of the most significant new knowledge added
