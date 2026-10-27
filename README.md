# my-assistant

> **Status (2026-10-27):** the scheduled routines described under the agentic framework (GitHub, Linear, Sentry, Slack detectors and the monitoring digest) are **paused**: their scheduled tasks are disabled. The design stays documented below; nothing was removed.

A personal AI assistant for developers, built as a Claude Code skill set.

Four skills that work together to give Claude a persistent, cumulative understanding of your work — and a structured multi-agent workflow for technical tasks.

---

## Skills

| Skill | Invoke | Purpose |
|---|---|---|
| `my-assistant` | `/my-assistant [domain]` | Session entry point — loads standing rules, shows a domain picker, deep-loads one domain, detects tasks |
| `my-assistant-update` | `/my-assistant-update` | **Deprecated.** One-time bulk import of old sessions into the legacy ledger |
| `my-assistant-save` | `/my-assistant-save` | Saves the session as classified, confirmed entries in per-domain files + history |
| `my-assistant-task` | `/my-assistant-task` | Multi-agent technical task workflow (bug fix, feature, refactor) |

---

## How it works

### Four knowledge layers

Every `/my-assistant` session loads, and every technical-task workflow reads:

1. **`CLAUDE.md`** (each project's own root, if present) — architecture, commands, codebase conventions. Auto-loaded by Claude Code for interactive sessions; explicitly read by the automated workflow pipeline below, since that behavior doesn't extend to spawned subagents.
2. **Memory files** (`~/.claude/projects/*/memory/*.md`) — structured notes Claude Code maintains per project directory: settled decisions, resolved investigations, standing feedback, accumulated organically over time.
3. **Domain files** (`<dataDir>/domains/*.md`, plus `global.md` for standing rules) — compact, ordered decisions with triggers, open items and one-line status, grown by `/my-assistant-save`. Session narrative lives in `history/<domain>.md` and is searched, not bulk-read. Older per-project notes live next to it as `history/<domain>.notes.md` (verbatim, read-only).
4. **Project structure** — a minimal scan of your project directories (file names only, no content reads).

If you're also running the automated-workflow pipeline (below) against specific repos, two more files sit alongside these per repo: a thin cross-cutting index and a per-project knowledge file, kept current by the workflows themselves rather than only by manual saves.

### Configuration — one question, ever

None of the four skills has a hardcoded default path. A fixed pointer file at `~/.claude/my-assistant/config-location` tells every skill where your real config lives. The very first time you run *any* of the four skills on a machine, that pointer doesn't exist yet — so it asks exactly one open-ended question ("where should your data directory live?"), then in one shot:

- creates the full data directory structure there (`index.md`, `domains/`, `history/`, `state/`, `diffs/`)
- resolves everything else it can (memory files dir, project scan dirs, session-transcripts dir) from documented conventions, without asking
- writes it all into `<dataDir>/config.json`
- writes the pointer at `~/.claude/my-assistant/config-location`

Every run after that reads the pointer, reads `config.json`, and proceeds silently — no questions, regardless of whether your data directory is the conventional default or somewhere completely different. If you tell a skill to change a stored value mid-session, it updates `config.json` immediately rather than just noting it verbally.

The installers (`install.ps1`/`install.sh`) only create the empty `~/.claude/my-assistant/` directory so it's there and writable — they never write the pointer file or `config.json` itself, since only a live skill invocation can actually ask that one bootstrap question.

### Technical task workflow

When `/my-assistant` detects a technical task, it offers `/my-assistant-task` — a pipeline built entirely on installed Superpowers skills rather than bespoke agent roles:

```
(Feature only: brainstorming → grill-me, or a self-interview simulation when unattended)
  → writing-plans          (rigorous plan: exact file paths, real code, no placeholders)
  → subagent-driven-development   (fresh Implementer per task → Task Reviewer → bounded fix loop)
  → requesting-code-review        (one independent reviewer, prompt-tailored by task type)
  → receiving-code-review         (triage: fix, or reasoned pushback — Critical findings always escalate)
  → verification-before-completion (fresh proof-command run, no claims without current evidence)
  → finishing-a-development-branch (always a draft PR — never merge, never mark ready)
```

Bug Fix and Refactor skip the Spec step — their scope is bounded enough not to need it. Every phase invokes the real installed skill by name rather than reimplementing its logic.

The same pipeline also runs unattended, triggered by GitHub/Linear/Sentry/Slack events against a configured set of repos — same review mechanism, same knowledge layers, same "always ends in a draft PR" policy. That part of the setup is more involved to configure than the base skills above; see the workflow scripts under `workflows/` if you want to adapt it.

**Prerequisite**: these workflow scripts have no way to ask a question, so they can't bootstrap `~/.claude/my-assistant/config-location` themselves the way the interactive skills do — they only read it. Run at least one of the four interactive skills first (which is what actually creates the pointer and `config.json`) before wiring up any `CronCreate` schedule against these scripts, or every run will fail at its first "Load Config" step with nothing to read.

### Knowledge accumulation

Knowledge grows only through confirmed saves:
- `/my-assistant-save` — builds ONE numbered proposal (decisions with triggers, open items, status, a history block); you answer "all" or the numbers to change; only then does it write
- `/my-assistant-task` — ends with the same save proposal for what the task taught
- `/my-assistant` — notices worthwhile moments and offers a save; it never writes on its own

All saves are **append-only** — a superseded decision moves to the history file marked `superseded by D-xxx`; nothing is deleted.

---

## Install

**Windows (PowerShell):**
```powershell
git clone https://github.com/ahmedelwakil/my-assistant
cd my-assistant
.\install.ps1
```

**macOS / Linux / WSL:**
```bash
git clone https://github.com/ahmedelwakil/my-assistant
cd my-assistant
chmod +x install.sh && ./install.sh
```

Restart Claude Code after installing. Skills are available immediately as slash commands.

---

## First run

1. Open Claude Code in any directory
2. Run `/my-assistant` — it asks the one bootstrap question (where your data directory should live) and sets up the data directory structure and `config.json` in one shot
3. Work as usual, and run `/my-assistant-save` at the end of a session: it shows one batched proposal and writes only what you confirm
4. Next session, `/my-assistant` loads your standing rules and shows a domain picker

---

## Data directory (knowledge + runtime state + config)

Knowledge, runtime state, and this deployment's own configuration all live in a directory you choose once, on first run (there's no baked-in default suggested to you — see "Configuration" above) — separate from this repo, which holds the skills/commands/workflow scripts themselves as the single source of truth. A tiny pointer file at `~/.claude/my-assistant/config-location` (created by that same first run) is what lets every later session find it again, wherever it is:

```
<wherever you chose>/
├── config.json                — this deployment's settings (see below); created on first run, never by the installers
├── index.md                   — thin index (layout, pointers)
├── domains/
│   ├── global.md              — standing rules (R-), always loaded
│   ├── <name>.md              — one per project/topic: context, status, decisions, open items
│   └── <area>.area.md         — optional: rules shared by the domains of one area
├── history/
│   ├── <name>.md              — session blocks, oldest first, searched not bulk-read
│   └── <name>.notes.md        — legacy per-project notes, verbatim (read-only)
├── state/
│   ├── routine-state.json     — per-platform, per-repo checkpoints
│   ├── kill-switch.json       — global + per-repo enable/disable
│   └── repo-locks.json        — concurrency/dedup for code-change routines
└── diffs/
    └── <project>-<task>-<date>/
        ├── step-01.diff
        ├── step-02.diff
        └── RESUME.md          — written on unrecoverable errors for safe resume
```

### `config.json`

```json
{
  "dataDir": "~/my-assistant-data",
  "memoryDir": "~/.claude/projects",
  "projectDirs": [],
  "namespaces": {},
  "workflowsDir": "/path/to/this/repo/workflows",
  "notify": { "platform": "slack", "userName": "your-name" },
  "repos": [
    { "name": "my-repo", "projectPath": "/path/to/my-repo", "owner": "my-org", "hasSentry": true, "sentryProject": "my-repo" }
  ]
}
```

- `dataDir`, `memoryDir`, `projectDirs`, `namespaces` — set in one shot on the very first run of any skill (see "Configuration" above). `projectDirs` starts empty: add folders when you name them.
- `namespaces` — optional separate trees (for example for someone else's work) that must stay apart from yours. Each entry: `"<name>": { "path": "<subfolder of dataDir>", "match": ["<word>"] }`, with its own `domains/` and `history/`. Namespaces are never scanned by the picker and load only when named.
- `workflowsDir`, `notify`, `repos` — only used by the optional automated-workflow pipeline (`workflows/dispatch/*.workflow.js`); the four interactive skills never read or write these. If you're setting up that pipeline, add them by hand — there's no interactive prompt for them today. This still requires `config-location` to already exist (see "Prerequisite" above) — those scripts read it the same way the interactive skills do, they just can't create it themselves.
- Each `repos[]` entry's `sentryProject` is optional and defaults to that entry's `name` if omitted — only set it explicitly when the Sentry project's actual name differs from the repo name (common when a repo maps to a differently-named backend service in Sentry).

---

### Optional: compaction hook

`hooks/my-assistant-compact.py` restores your pinned standing rules and the active domain's pinned decisions after a context compaction. It is read-only, never fails a session, and is not installed by the installers; see `hooks/README.md` for the one settings entry it needs.

---

## Requirements

- [Claude Code](https://claude.ai/code) v2.1.101 or later
- Optional: [Linear MCP connector](https://claude.ai/customize/connectors) for ticket integration

---

## License

MIT
