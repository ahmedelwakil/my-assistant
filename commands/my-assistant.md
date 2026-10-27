---
name: my-assistant
description: Load the user's personal assistant context at the start of a session. Use when the user runs /my-assistant, says "load my context", "act as my assistant", or starts a session about their projects, personal matters or work. Loads standing rules plus a domain picker, then deep-loads only the chosen domain.
---

# /my-assistant

Load the user's assistant context and enter assistant mode. Principle: **disk is the source of truth, your context is only a cache.** Anything you need to be sure of, re-read from disk. Reading is *complete in coverage, selective in depth* (measured: about 2,500 tokens of core data plus 1,250 for the picker; with this skill file and the config it is about 6,000 at the greeting; then 1,000-3,500 for one domain and its area file): always load the standing rules and a one-line status for every domain, deep-load only the domain in play, and pull everything else in through triggers.

Usage: `/my-assistant` or `/my-assistant <domain>` (e.g. `/my-assistant payments-api`).

## Step 1: Load configuration

Check for `~/.claude/my-assistant/config-location` (resolve `~` to the home directory).

- **Exists**: read `configPath`, then that file. Use `dataDir`, `memoryDir`, `projectDirs` directly; never ask about anything already there.
- **Missing** (first run on this machine): ask exactly one open question, with no suggested default: "Where should your my-assistant data directory live?" Then:
  1. Create `dataDir` with: `index.md` (skeleton), `domains/global.md` (empty rules list), `domains/`, `history/`, `projects/`, `state/`.
  2. Resolve without asking: `memoryDir` → `~/.claude/projects`; `projectDirs` → `[~/claude workspace, ~/Workspace]`.
  3. Write them into `<dataDir>/config.json`, and `{ "configPath": "<dataDir>/config.json" }` into the pointer file.
  4. Tell the user plainly what was set up. Offer `/my-assistant-save` as the way knowledge gets in.

If the user changes a stored value during a session, update `config.json` immediately.

## Step 2: Core load (always, about 2,500 tokens)

1. Read `<dataDir>/index.md` (thin: layout, pointers, shared notes).
2. Read `<dataDir>/domains/global.md` down to the `## Global notes` heading (the pinned `R-` standing rules, about 2,000 tokens). Obey them for the whole session. The notes below that heading are tool and environment gotchas: do not load them; Grep them by trigger in the sweep (Step 6).
3. Do not bulk-read memory files. The memory index is already in your context; open a memory file only when an entry's `src:` or a trigger points to it.
4. Do not read `base-knowledge.md` or anything under `history/`. They are archives, reached only through search (Step 6).

## Step 3: Build the picker (measured: about 1,250 tokens for 16 domains)

Run exactly ONE Grep: pattern `^(domain|area|lifecycle|sensitive|status):`, path `<dataDir>/domains`, glob `*.md`, output mode `content`, **no context lines and no line numbers** (`-n` false). Ignore `global.md`, `*.area.md` and `_*` files in the results. Each domain file keeps a one-line `status:` (at most about 120 characters) in its frontmatter for exactly this purpose. Rules for what shows:
- List `lifecycle: active` only. `paused` and `archived` are hidden but stay in this grep result: if the user asks for them ("is X active?", "show everything paused"), answer from it; re-run the grep if it is no longer in context.
- Hide `sensitive: true` domains from the list, but count them: "N sensitive domains hidden, name one to load it". If the user asks directly ("do I have sensitive domains?", "show everything paused"), name them, tagged `sensitive`, and still do not load them until asked.
- Count the hidden paused/archived ones too: "N paused hidden, ask to see them".
- Namespaces (`config.json` `namespaces`, other than the default) are not scanned. Mention them in one line ("Other namespace: <name>, name it to load"). The same sensitive/paused rules apply inside a namespace once it is named.
- Group by `area`. Names come from the files, never from this skill's text.

## Step 4: Greet, or skip straight to the load

- If the user gave an argument, or their first message names a ticket, repo, project or domain: skip the picker and go to Step 5.
- Otherwise greet with: (1) one line saying what you loaded, (2) a 3-5 bullet snapshot of current work from the status lines, (3) the picker as a **numbered plain-text list** (domain, `status:` line), grouped under area headings (number only the domains, continuously, so "load 5" works), no pre-selected default, the status lines presented as a snapshot from disk (not live state; a `?` in a status means unverified), then the hidden-domain and namespace lines, and the closing question: "Which one are we loading in depth (or none, for a general session)?"
- "None" or a personal/general topic means core load only (and clear `state/active-session.json` by overwriting it with `{}` so stale state is never restored). That is a valid session. If the user then asks about a domain or names one, treat that as naming it and do Step 5 for it (this includes paused and sensitive domains once named).
- **Another namespace** (the user names it, or its `match` words appear): read `<namespace path>/index.md` if it exists, then its `domains/` files the same way (grep for the picker, read the one needed). Keep its content apart from the default namespace's.

## Step 5: Deep load of the chosen domain

1. Read `<dataDir>/domains/<domain>.md` in full, plus `domains/<area>.area.md` if that file exists.
2. If the domain has more than about 30 live `D-` decisions (count only that domain's own), read the `[pin]` entries in full and only the ID + triggers line of the rest (a trigger index); fetch the full entry when a trigger matches.
3. Record what you loaded (only when a domain was deep-loaded): write `<dataDir>/state/active-session.json` as `{"domain": "...", "area": "...", "loaded": "<ISO time>"}` so context can be restored after compaction.
4. If the domain's frontmatter lists `live-sources`, offer once: "Want me to check live state (open PRs, tickets, alerts) before we start?" Never run it automatically.
5. Memory and the domain file may disagree: the newer `decided:` date wins. Flag a real conflict to the user.

## Step 6: During the session

- **Sweep before acting.** Before writing a plan, and before any external or irreversible action (push, PR, ticket, message, deploy, delete), Grep the loaded domain, its area file and `global.md` for triggers matching the files, classes, tickets and systems you are about to touch. Read from disk, not from memory of what you loaded. If nothing matches in the domain file, Grep `history/<domain>.md` as a fallback, and search with SEVERAL keyword variants (the thing, its synonyms, role words such as "contact", "engineer", "owner", names, ticket IDs), not one term. If a fact you needed was found only in history, tell the user and offer to promote it into the domain file at the next save.
- **Show the line only on a match**: `Sweep: D-014 (metadata is []), R-004 (no AI attribution)`. Put matches into the plan and into every subagent prompt you write; subagents have no session history.
- **Context loss.** If you cannot recall the pinned rules or the active domain (after compaction, a long session, or a doubt), re-read the pinned part of `global.md` and `state/active-session.json` and the domain file before continuing.
- **Misses.** If the user says "as I told you", "we already decided", or corrects you on something that should have been known, find the decision (Grep domain, then history), apply it, and tell the user which trigger or synonym failed so it can be fixed at the next save.
- **Switching domain mid-session**: do a Step 5 load for the new domain; keep the old one's pinned entries in mind.

## Technical task detection

Offer the full workflow once when a message signals a coding task: a bug report or error, an implementation or refactor request, a ticket ID, a file and line reference, or an explicit "fix/handle this". Confirm your understanding in 1-2 sentences, then ask: "This looks like a technical task. Want the full multi-agent workflow (`/my-assistant-task`: plan, TDD, review, verification)?" Yes → invoke `/my-assistant-task` with the context gathered. No → handle it conversationally. If the user has said to use the workflow by default, or asks why you did not, use it without asking. Do not offer it for questions, brainstorming or trivial edits.

## Saving knowledge

Do not append to files ad hoc. When something worth keeping happens (a decision, a correction, a "remember this", a finished piece of work), note it and offer `/my-assistant-save` at a natural pause or at session end ("Before you go, want me to save today's decisions? Here is what I would capture: ..."). If the user says "remember this" explicitly, run the save flow for just that item.
