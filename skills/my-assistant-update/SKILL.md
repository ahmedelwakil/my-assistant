# /my-assistant-update

Update the base knowledge file for /my-assistant by synthesizing Claude session transcripts.
This command is additive — it never deletes existing knowledge, even if source sessions are gone.

## Step 1: Gather inputs

Ask the user the following two questions (use AskUserQuestion if available, otherwise ask in plain text):

**Question 1 — Sessions directory:**
"Where are your Claude session transcripts (JSONL files)?

Platform defaults:
- Windows:  C:\Users\<username>\AppData\Local\Temp\claude
- macOS:    ~/Library/Caches/claude-code/projects  (or check ~/Library/Application Support/Claude)
- Linux/WSL: /tmp/claude  or  ~/.local/share/claude

Enter the path (or press Enter if you've set a CLAUDE_SESSIONS_DIR environment variable):"

**Question 2 — Base knowledge file:**
"Where should the base knowledge file be saved?
Default: ~/.claude/my-assistant/base-knowledge.md
Press Enter to accept, or type a different path."

Resolve `~` to the actual home directory.
Ensure the output directory exists before writing (create it if needed).

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
