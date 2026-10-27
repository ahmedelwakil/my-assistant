---
name: my-assistant-save
description: Save the current session's knowledge into the user's my-assistant data, structured and ordered, so later /my-assistant loads find it. Use when the user runs /my-assistant-save, says "save this session", "remember this", "note that", or is wrapping up a session that produced decisions, corrections or open items.
---

# /my-assistant-save

Save this session's knowledge so that a later `/my-assistant` load finds it with minimum tokens. Nothing is written until the user confirms ONE batched proposal. Nothing is ever deleted: old material is marked superseded and moved to history.

## Where knowledge lives

```
<dataDir>/
  index.md              thin: layout + pointers
  domains/global.md     standing rules (R-), always loaded, plus global notes
  domains/<name>.md     one per project/topic: sections 1-6 below, always read in full on deep load
  domains/<area>.area.md  optional: rules shared by several domains of one area
  history/<name>.md     session blocks, oldest first, searched, never bulk-read
  history/<name>.notes.md  legacy per-project notes, verbatim (read-only: never write to a *.notes.md file)
```

Domain file layout (keep the headings exactly): frontmatter (`domain`, `area`, `lifecycle` active|paused|archived, `namespace`, `sensitive`, `status` = one line of at most ~120 characters that the picker greps, `as-of`, optional `live-sources`), then `## 1. Context`, `## 2. Status` (ONE line), `## 3. Live decisions`, `## 4. Open items`, `## 5. Conventions and gotchas`, `## 6. Pointers and history`.

Decision entry (about 60 tokens):
```
- D-014 [pin] <the rule in one or two sentences>.
  triggers: metadata, meta_data, swagger, casts | decided: 2026-09-30 (PR #52)
  why: <one clause> | src: <memory file, history block or doc>
```
Standing rule in `global.md`: `R-007 <rule>. | triggers: ... | why: ... | src: ...`.

## Step 1: Load configuration

Use `dataDir` if known this session, else `~/.claude/my-assistant/config-location` → `configPath` → `config.json`. If the pointer is missing, ask the single question "Where should your my-assistant data directory live?" and set it up as `/my-assistant` Step 1 does.

## Step 2: Identify the domains touched

From the conversation (and `state/active-session.json`), list the domains this session worked in. A new topic with no domain file gets a proposed new domain (name, area, lifecycle) in the batch. A session spanning two domains gets one history block and a one-line pointer in the other's history.

## Step 3: Extract candidates

Review the whole session. Scan for decision language ("we agreed", "from now on", "always", "never", "I don't want", "don't", "decided", corrections of your behavior). Extract:
- **Decisions and rules**, each with a class, a pin flag, triggers and synonyms:
  - *standing rule*: still true in a session with no codebase and in a different project (strip every repo, client, person and system name and re-test). → `global.md`.
  - *scoped decision*: tied to one domain or area → that domain's (or area's) Live decisions.
  - *narrative*: what happened, no future rule → history block only.
- **Open items** (new, and existing ones now done), **status** (one line), **conventions and gotchas**, and the **history block**.
- **Pin** a scoped decision only if missing it would cause real harm in most sessions of that domain (a gate before a PR, a never-do, a convention that reviewers check). Keep pins to about 5-8 per domain.
- **A note is not a fourth class**: a gotcha with no rule in it goes to `## 5. Conventions and gotchas`; ticket narrative goes to the history block only.
- **Uncertain class**: ask the user, with your suggested class and what you would write meanwhile (default: a line in the history block only). Never guess silently.
- **User-stated facts** ("PR merged", "issue resolved"): verify live when it is cheap; otherwise save them marked as user-reported with the date.

## Step 4: Duplicate and conflict check

Grep the target domain file, its area file, `global.md` and the domain's history file (superseded entries) for each candidate's triggers. Do not re-save what exists. If it contradicts an existing entry, propose superseding it: new ID, the old entry moves to history marked `superseded by D-xxx`. If only part of the old entry is reversed, the new entry restates what survives (split, never leave the old one half-true). If nothing new was learned, say so and stop; write nothing.

## Step 5: ONE numbered proposal

First, snapshot before-counts (history line counts, headings per domain file, file sizes) and compute each target file's size AFTER the proposed writes. If a domain would exceed its budget, the proposal itself must include what moves to history (retire the oldest ticket-specific or narrative-only entries first, never pinned or rule-bearing ones; moved entries keep their full text in `## Superseded decisions` or a `## Retired` list in the history file, marked, never deleted). Then show a single numbered list: each candidate with its class, target file, pin flag and triggers, plus any such moves and any memory writes. The user answers "all" (which approves every numbered item, including budget moves and memory writes) or the numbers to change. Do not write before this answer. A proposal touching `CLAUDE.md` or any file in a shared repo shows the diff and needs its own confirmation; first verify whether it is gitignored. Standing rules are also written to the memory directory of the current project (a `feedback_<slug>.md` file with name/description/type frontmatter, a **Why:** and **How to apply:** line, plus one line in `MEMORY.md`; duplicate-checked) so they survive on the machine too.

## Step 6: Write

- **Status**: replaced, never appended: update BOTH the frontmatter `status:` (short, at most ~120 characters, a state not a log) and the `## 2. Status` line, and `as-of`.
- **Open items**: check off finished ones with a date (`[x] ... (2026-10-27)`); add new ones with an as-of date.
- **Live decisions**: append with the next free ID (highest ID across live and history, plus one). IDs are permanent and never reused.
- **Standing rules**: next `R-` ID. A pinned rule goes at the end of the pinned section (just above `## Global notes`); an unpinned tool/environment note goes at the end of the file. The pinned section stays under about 8,000 characters (move the least critical to notes if it would not).
- **History**: append one block, oldest first, to `history/<primary domain>.md`:
  ```
  ### Session: <YYYY-MM-DD HH:MM> — <topic>
  **Done:** ... **Decided:** D-0xx, D-0yy **Open:** ... **Context:** ...
  ---
  ```
  The block timestamp is the current clock at save time. Superseded and retired decisions go under a `## Superseded decisions` heading at the END of the same history file (create it if missing), one entry each with its full original text and `superseded by D-xxx (date)`.
- **Status** carries forward clauses for work this session did not touch, replacing only what changed.
- Create new domain files from the layout above.

## Step 7: Verify and report

1. History line counts only grew; no section heading vanished from any domain file.
2. Each domain file is within budget (about 8-12 KB, 2,000-3,000 tokens; the largest active domains may reach about 14 KB). If a write would exceed it, **stop and propose what to move to history first**; do not trim silently. A domain past about 100 live decisions triggers a consolidation proposal (merge, retire to history) that the user confirms.
3. IDs unique; triggers present on every decision (add synonyms).
4. Layout integrity: no `*.notes.md` file changed; every domain file still has its frontmatter (including `status:`) and all six sections; every `src:` points at a memory file, a `history/` file, a repo doc or a user instruction, never at a path outside this layout; nothing new was written outside `domains/`, `history/`, `state/` and the memory directory.
5. Report per file: what was added, what was superseded, what was skipped as already known, and anything awaiting confirmation.

If the user later says "as I told you" about something missing, ask which decision it was, fix its triggers or synonyms, and note the miss in `state/miss-log.md`.
