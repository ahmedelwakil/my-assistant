---
name: my-assistant-save
description: Save the current session's knowledge into the user's my-assistant data, structured and ordered, so later /my-assistant loads find it. Use when the user runs /my-assistant-save, says "save this session", "remember this", "note that", or is wrapping up a session that produced decisions, corrections or open items.
---

# /my-assistant-save

Save this session's knowledge so that a later `/my-assistant` load finds it with minimum tokens. The user does not confirm a save: write it directly, then report exactly what was written (the report is the review, and the history file keeps every old text so nothing is lost). Nothing is ever deleted: old material is marked superseded and moved to history.

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

Follow `/my-assistant` Step 1: read the config pointer and `config.json`; if the pointer is missing, run the single first-run bootstrap described there.

## Step 2: Identify the domains touched

From the conversation (and `state/active-session.json`), list the domains this session worked in. A new topic with no domain file gets a new domain file (name, area, lifecycle), created in this save. A session spanning two domains gets one history block and a one-line pointer in the other's history. A session in a namespace (see `config.json` `namespaces`) writes into that namespace's own `domains/` and `history/`, never into the default tree.

## Step 3: Extract candidates

Review the whole session. Scan for decision language ("we agreed", "from now on", "always", "never", "I don't want", "don't", "decided", corrections of your behavior) AND for to-do language ("later", "next", "waiting on", "follow up", "pending", "blocked", "remind me", "still need", "TODO", "don't forget", "after X is done"): each hit is a candidate decision or a candidate open item. Extract:
- **Decisions and rules**, each with a class, a pin flag, triggers and synonyms:
  - *standing rule*: still true in a session with no codebase and in a different project (strip every repo, client, person and system name and re-test). → `global.md`.
  - *scoped decision*: tied to one domain or area → that domain's (or area's) Live decisions.
  - *narrative*: what happened, no future rule → history block only.
- **Open items pass**, for every domain touched. Look at each current item in `## 4. Open items`, but show the user only what CHANGES or needs a decision, never a table of everything:
  - mentioned this session: a verdict (still open, done, or dropped, with the reason) and how you know;
  - names a PR or ticket, and it was mentioned this session or is older than 14 days: check it live (GitHub or Linear, whichever tools exist), at most about 5 live checks per domain, and say which you skipped;
  - not mentioned and younger than 14 days: leave it as is and say nothing;
  - not mentioned and older than 14 days: leave them as is, marked `unverified`, and list them with their ages in the report (no question);
  - nothing you can check: keep it and mark it `unverified`.
  Treat each line as one item; a composite line naming more than about 3 tickets is split into one line per ticket. A to-do that restates an existing item updates that item in place, it never adds a duplicate. Then add new items from this session. Every item carries `(as of YYYY-MM-DD)`, the date it was last CHECKED: change it only when you actually verified the item this session. If the user gives a target date ("chase on Friday"), also write `(due YYYY-MM-DD)` with an explicit date; when the item can be checked, add a hint (`check: PR #71`). Keep in the domain only what no ticket tracks, and do not propose filing a ticket just to track an item.
  - **A fact the user states that contradicts live state** (for example "PR #71 was merged" while GitHub shows it open): do NOT record it as true and do NOT mark the item done. Record it as user-reported with today's date, show both in the report, and do not ask.
- **Status** (one line), **conventions and gotchas**, and the **history block**.
- **Pin** a scoped decision only if missing it would cause real harm in most sessions of that domain (a gate before a PR, a never-do, a convention that reviewers check). Keep pins to about 5-8 per domain.
- **A note is not a fourth class**: a gotcha with no rule in it goes to `## 5. Conventions and gotchas`; ticket narrative goes to the history block only.
- **Uncertain class**: do not ask. Write it as a line in the history block only (the safe default) and name it in the report with the class you would have suggested, so the user can say "make it a rule".
- **User-stated facts** ("PR merged", "issue resolved"): verify live when it is cheap; otherwise save them marked as user-reported with the date.

## Step 4: Duplicate and conflict check

Grep the target domain file, its area file, `global.md` and the domain's history file (superseded entries) for each candidate's triggers. Do not re-save what exists. If it contradicts an existing entry, supersede it: new ID, the old entry moves to history marked `superseded by D-xxx`. If only part of the old entry is reversed, the new entry restates what survives (split, never leave the old one half-true). If nothing new was learned, say so and stop; write nothing.

## Step 5: Decide and write (no confirmation)

Snapshot before-counts (history line counts, headings per domain file, file sizes). There is no per-domain size cap: size alone is never a reason to move or cut anything. Move an entry to history only to retire something superseded or stale, with its full text kept in `## Superseded decisions` or a `## Retired decisions` list in the history file, marked, never deleted. Settle every candidate yourself (class, target file, pin flag, triggers) and go straight to Step 6; do not show a numbered proposal and do not wait for an answer. Standing rules are also written to `<memoryDir>/<project-slug>/memory/` (project-slug = the working directory path with colons, slashes, backslashes and spaces replaced by '-', Claude Code's own convention; if that directory does not exist, skip the memory write and say so) (a `feedback_<slug>.md` file with name/description/type frontmatter, a **Why:** and **How to apply:** line, plus one line in `MEMORY.md`; duplicate-checked) so they survive on the machine too. The one exception is a file inside a code repo (for example its `CLAUDE.md`): if it is gitignored (private) it is written like any other item; if it is tracked or shared, do not edit it, show the diff and ask for its own confirmation.

## Step 6: Write

- **Re-read** each target file immediately before writing it: other sessions write the same files, so edit and allocate IDs from the file as it is at that moment.
- **Lock**: if `state/.write.lock` exists and is younger than 10 minutes, wait or ask the user; create it before writing and remove it afterwards (the workflows use the same file).
- **Status**: replaced, never appended: update BOTH the frontmatter `status:` (short, at most ~120 characters, a state not a log) and the `## 2. Status` line, and `as-of`.
- **Open items**: for each verdict: still open and re-checked today means update its `(as of ...)` date; done means `[x] ... (date)`; dropped means `[x] dropped: reason (date)`. Move `[x]` items whose done date is before today out of the domain file into the history block's **Done** line (nothing is deleted, they just stop crowding the live list). Add new items with an as-of date.
- **Live decisions**: append with the next free ID: the highest ID among entries that START a line (`- D-nnn`) in the live file and in the `## Superseded decisions` / `## Retired decisions` sections of its history file, plus one. Never read IDs from other text in history or notes files (that text contains stray look-alikes). IDs are permanent and never reused.
- **Standing rules**: next `R-` ID (same counting rule, over `global.md` only). A pinned rule goes at the end of the pinned section (just above `## Global notes`); an unpinned tool/environment note goes at the end of the file. The pinned rule lines (the lines the loader reads) stay under about 4,500 characters in total and each rule line under about 400; if they would not, move the least critical rule to the notes.
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
2. Size report (information only, never a gate and never a reason to move or trim anything): for each domain written, state its size in KB and approximate tokens (bytes divided by 4) and its live decision count. Mention once, as a suggestion for the user to accept or ignore, when a domain passes about 20 KB (about 5,000 tokens), has more than 30 live decisions (the loader then reads only pinned entries plus a trigger index), has more than 100 (propose a consolidation: merge, retire to history, which the user confirms), or has open items whose as-of date is older than 30 days.
3. IDs unique; triggers present on every decision (add synonyms); every open item carries an ISO date (the latest one is its age; an item with none counts as stale).
4. Layout integrity: no `*.notes.md` file changed; every domain file still has its frontmatter (including `status:`) and all six sections; every `src:` points at a memory file, a `history/` file, a repo doc or a user instruction, never at a path outside this layout; nothing new was written outside `domains/`, `history/`, `state/` and the memory directory.
5. Report per file: what was added, what was superseded, what was skipped as already known, and anything the user may want to correct (facts recorded as user-reported, items defaulted to history only, stale items left unverified). Undo is a re-edit: old text is always in the history file.

If the user later says "as I told you" about something missing, ask which decision it was, fix its triggers or synonyms, and note the miss in `state/miss-log.md`.
