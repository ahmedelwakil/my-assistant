---
name: my-assistant
description: Load the user's personal assistant context at the start of a session. Use when the user runs /my-assistant or asks to load their context or to act as their assistant. Loads the standing rules and a domain picker, then deep-loads the chosen domain.
argument-hint: "[domain]"
---

# /my-assistant

Load the user's assistant context and enter assistant mode. Principle: **disk is the source of truth, your context is only a cache.** Anything you need to be sure of, re-read from disk. Reading is *complete in coverage, selective in depth* (measured: about 1,600 tokens of core data plus 1,250 for the picker; with this skill file and the config about 6,000 at the greeting; then about 1,000-5,500 for one domain and its area file, the largest being about 5,000): always load the standing rules and a one-line status for every domain, deep-load only the domain in play, and pull everything else in through triggers.

Usage: `/my-assistant` or `/my-assistant <domain>` (e.g. `/my-assistant payments-api`).

## Step 1: Load configuration (the single bootstrap; the other skills refer to this step)

Check for `~/.claude/my-assistant/config-location` (resolve `~` to the home directory). It is a small JSON file: `{ "configPath": "<path to config.json>" }`.

- **Exists**: read `configPath`, then that file. Use `dataDir`, `memoryDir` and `namespaces` directly; never ask about anything already there. If the pointer exists but the config file or `dataDir` is missing, say so and offer to recreate it; do not silently start over.
- **Missing** (first run on this machine): ask exactly one open question with no suggested default: "Where should your my-assistant data directory live?" Normalise the answer to an absolute path (`~` is the home directory, `%USERPROFILE%` on Windows; use forward slashes). If that folder already exists and is not empty, ask before using it. Then:
  1. Create `<dataDir>` with the folders `domains/`, `history/` and `state/`, and create `~/.claude/my-assistant/` if it does not exist.
  2. Write `<dataDir>/index.md` (a title, one line saying it is a thin index, and an empty "Areas" list) and `<dataDir>/domains/global.md` with this exact starter: frontmatter (`domain: global`, `lifecycle: active`, `as-of: <today>`), the heading `# global: standing rules`, one comment line showing the entry format (`- R-001 [pin] <rule>.` then `  triggers: a, b | why: ... | src: ...`), and an empty heading `## Global notes (found by trigger, not pinned)`.
  3. Write `<dataDir>/config.json`: `{ "dataDir": "<dataDir>", "memoryDir": "~/.claude/projects", "projectDirs": [], "namespaces": {} }`. Do not guess project folders: add them when the user names them. A namespace entry looks like `"<name>": { "path": "<subfolder>", "match": ["<word>"] }` (a separate tree with its own `domains/` and `history/`, loaded only when named).
  4. Write the pointer file with `configPath`.
  5. Tell the user plainly what was created, and offer `/my-assistant-save` as the way knowledge gets in.

If the user changes a stored value during a session, update `config.json` immediately.

## Step 2: Core load (always, about 1,600 tokens of data)

1. Read `<dataDir>/index.md` (thin: layout, pointers, shared notes).
2. Run ONE Grep on the single file `<dataDir>/domains/global.md` (a file path, so the output has no filename prefix): pattern `^- R-[0-9]+ \[pin\]`, output mode `content`, no line numbers, no context. That returns only the pinned standing-rule lines (about 1,000 tokens): obey them for the whole session. Their `triggers/why/src` lines and the `## Global notes` section (tool and environment gotchas) are not loaded; Grep them by trigger in the sweep (Step 6). An empty result just means there are no pinned rules yet: carry on.
3. Do not bulk-read memory files. The memory index is already in your context; open a memory file only when an entry's `src:` or a trigger points to it.
4. Do not read anything under `history/` (session blocks in `<name>.md`, the old per-project notes in `<name>.notes.md`). They are reached only through search (Step 6) and are never edited.

## Step 3: Build the picker (measured: about 1,250 tokens for 14 domains)

Skip this step entirely when the user gave an argument or named a ticket, repo, project or domain (see Step 4): the picker would be unused.

Run exactly ONE Grep: pattern `^(domain|area|lifecycle|sensitive|status):`, path `<dataDir>/domains`, glob `*.md`, output mode `content`, **no context lines and no line numbers** (`-n` false). Ignore `global.md`, `*.area.md` and `_*` files in the results. Keep the filename prefix (it names the domain); a domain with no `status:` line shows as "(no status)". Each domain file keeps a one-line `status:` (at most about 120 characters) in its frontmatter for exactly this purpose. Rules for what shows:
- List `lifecycle: active` only. `paused` and `archived` are hidden but stay in this grep result: if the user asks for them ("is X active?", "show everything paused"), answer from it; re-run the grep if it is no longer in context.
- Hide `sensitive: true` domains from the list, but count them: "N sensitive domains hidden, name one to load it". If the user asks directly ("do I have sensitive domains?", "show everything paused"), name them, tagged `sensitive`, and still do not load them until asked.
- Count the other hidden domains once: "M paused or archived hidden, ask to see them". A domain that is both sensitive and paused/archived counts only in the sensitive number.
- Namespaces (`config.json` `namespaces`, other than the default) are not scanned. Mention them in one line ("Other namespace: <name>, name it to load"). The same sensitive/paused rules apply inside a namespace once it is named.
- Group by `area`. Names come from the files, never from this skill's text.

## Step 4: Greet, or skip straight to the load

- If `domains/` holds no domain files besides `global.md` (a fresh install), skip the picker and say: "No domains yet. We can run a general session, and `/my-assistant-save` at the end will create your first domain."
- If the user gave an argument, or their first message names a ticket, repo, project or domain: skip the picker and go to Step 5.
- Otherwise greet with: (1) one line saying what you loaded, (2) a 3-5 bullet snapshot of current work from the status lines, (3) the picker as a **numbered plain-text list** (domain, `status:` line), grouped under area headings (number only the domains, continuously, so "load 5" works), no pre-selected default, the status lines presented as a snapshot from disk (not live state; a `?` in a status means unverified), then the hidden-domain and namespace lines, and the closing question: "Which one are we loading in depth (or none, for a general session)?"
- "None" or a personal/general topic means core load only (and clear `state/active-session.json` by overwriting it with `{}` so stale state is never restored). That is a valid session. A question the picker grep already answers (is it active, what is its status) is answered from that grep without loading anything. Only when the user asks for more than that, or asks to load or work on a domain, do Step 5 for it (this includes paused, archived and sensitive domains once named).
- **Another namespace**: when the user names it, or a name that is NOT an existing default-namespace domain matches one of its `match` words (an exact default-namespace domain name always wins, even if it contains a match word), read `<namespace path>/index.md` if it exists, then its `domains/` files the same way (grep for the picker, read the one needed). Keep its content apart from the default namespace's.

## Step 5: Deep load of the chosen domain

1. Read `<dataDir>/domains/<domain>.md` in full, plus `domains/<area>.area.md` if that file exists.
2. If the domain has more than about 30 live `D-` decisions (count only that domain's own), read the `[pin]` entries in full and only the ID + triggers line of the rest (a trigger index); fetch the full entry when a trigger matches.
3. Record what you loaded (only when a domain was deep-loaded): write `<dataDir>/state/active-session.json` as `{"domain": "...", "area": "...", "namespace": "<name or empty>", "loaded": "<ISO time>"}` so context can be restored after compaction.
4. If the domain's frontmatter lists `live-sources`, offer once: "Want me to check live state (open PRs, tickets, alerts) before we start?" Never run it automatically.
5. Reconcile with memory (only if a memory index is present in your context): other sessions still write project status into the memory directory. In that index, find lines naming this domain or its repo; if a matching memory file was modified later than the domain file itself (compare last-modified times, for example with `stat` or PowerShell `(Get-Item <file>).LastWriteTime`; the `as-of` date has no time of day, so it cannot settle same-day edits), read it, treat its newer facts as updates, tell the user which facts differ, and offer to save them. On a real conflict the newer `decided:` date wins; flag it.
6. Stale items: an open item's date is the LATEST ISO date in it (an item with no date counts as stale). Do not ask a question. If the domain has open items older than 30 days or past their `(due YYYY-MM-DD)` date, say so in one line with the count and the oldest 3 with their ages, and move on; the user can ask "what is open?" or `/my-assistant-save` re-checks them. Paused or archived domains get the count only.

## Step 6: During the session

- **Sweep before acting.** Before writing a plan, and before any external or irreversible action (push, PR, ticket, message, deploy, delete), Grep the loaded domain, its area file and `global.md` for triggers matching the files, classes, tickets and systems you are about to touch. Read from disk, not from memory of what you loaded. If nothing matches in the domain file, Grep `history/<domain>*.md` (session blocks and notes) as a fallback, and search with SEVERAL keyword variants (the thing, its synonyms, role words such as "contact", "engineer", "owner", names, ticket IDs), not one term. Each `history/<name>.notes.md` starts with a Contents list (lines like `- L40: <section title>`): Grep that first (pattern `^- L[0-9]+:` plus your keyword), then Read from the listed line with an offset and limit. The Grep tool shows very long lines as "[Omitted long matching line]"; when you see that, Read that line range instead of searching again. If a fact you needed was found only in history, tell the user and offer to promote it into the domain file at the next save.
- **Show the line only on a match**: `Sweep: D-014 (metadata is []), R-004 (no AI attribution)`. Put matches into the plan and into every subagent prompt you write; subagents have no session history.
- **Context loss.** If you cannot recall the pinned rules or the active domain (after compaction, a long session, or a doubt), re-run the pinned-rules Grep from Step 2, then read `state/active-session.json` and the domain file before continuing.
- **Misses.** If the user says "as I told you", "we already decided", or corrects you on something that should have been known, find the decision (Grep domain, then history), apply it, and tell the user which trigger or synonym failed so it can be fixed at the next save.
- **What is open?** When the user asks what is open, pending or waiting: Grep `^- \[ \]` in the loaded domain, or across the active, non-sensitive domains if none is loaded (never include a sensitive domain unless the user named it), and show each item with its latest ISO date and age, oldest first, at most 20 (then "and N more"). Flag items older than 30 days, past their `(due ...)` date, or with no date, and offer to check live the ones that name a PR or ticket.
- **Quick note.** When the user asks you to remember something for later ("remind me", "next time", "waiting on X", "follow up on Y"): add ONE open item to the active domain right away, no confirmation (if no domain is loaded, ask which, the only allowed question). The line is `- [ ] <text> (as of YYYY-MM-DD)`, with relative dates ("next week") turned into an explicit date. Take `state/.write.lock`, re-read ONLY the `## 4. Open items` section (Grep `-n` for the section headings, then Read that range), append the line at the end of that section (before `## 5.`), release the lock, and tell the user the exact line you added. It works on a paused domain too. It is a one-line edit, not a full save.
- **Switching domain mid-session**: do a Step 5 load for the new domain; keep the old one's pinned entries in mind.

## Technical task detection

Offer the full workflow once when a message signals a coding task: a bug report or error, an implementation or refactor request, a ticket ID, a file and line reference, or an explicit "fix/handle this". Confirm your understanding in 1-2 sentences, then ask: "This looks like a technical task. Want the full multi-agent workflow (`/my-assistant-task`: plan, TDD, review, verification)?" Yes → invoke `/my-assistant-task` with the context gathered. No → handle it conversationally. If the user has said to use the workflow by default, or asks why you did not, use it without asking. Do not offer it for questions, brainstorming or trivial edits.

## Saving knowledge

Do not append to files ad hoc (the one exception is the one-line Quick note above). When something worth keeping happens (a decision, a correction, a "remember this", a finished piece of work), note it and offer `/my-assistant-save` at a natural pause or at session end ("Before you go, want me to save today's decisions? Here is what I would capture: ..."). If the user says "remember this" explicitly, run the save flow for just that item.
