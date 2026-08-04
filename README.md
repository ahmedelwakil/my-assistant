# my-assistant

A personal AI assistant for developers, built as a Claude Code skill set.

Four skills that work together to give Claude a persistent, cumulative understanding of your work — and a structured multi-agent workflow for technical tasks.

---

## Skills

| Skill | Invoke | Purpose |
|---|---|---|
| `my-assistant` | `/my-assistant` | Session entry point — loads knowledge, detects tasks, offers workflow |
| `my-assistant-update` | `/my-assistant-update` | Bulk-imports past Claude sessions into your base knowledge |
| `my-assistant-save` | `/my-assistant-save` | Checkpoints the current session into base knowledge |
| `my-assistant-task` | `/my-assistant-task` | Multi-agent technical task workflow (bug fix, feature, refactor) |

---

## How it works

### Four knowledge layers

Every `/my-assistant` session loads, and every technical-task workflow reads:

1. **`CLAUDE.md`** (each project's own root, if present) — architecture, commands, codebase conventions. Auto-loaded by Claude Code for interactive sessions; explicitly read by the automated workflow pipeline below, since that behavior doesn't extend to spawned subagents.
2. **Memory files** (`~/.claude/projects/*/memory/*.md`) — structured notes Claude Code maintains per project directory: settled decisions, resolved investigations, standing feedback, accumulated organically over time.
3. **Base knowledge** (`~/claude workspace/my-assistant/base-knowledge.md` by default — configurable) — a synthesized, cumulative record of everything Claude has helped you with across all past sessions. Built by `/my-assistant-update`, grown by `/my-assistant-save`.
4. **Project structure** — a minimal scan of your project directories (file names only, no content reads).

If you're also running the automated-workflow pipeline (below) against specific repos, two more files sit alongside these per repo: a thin cross-cutting index and a per-project knowledge file, kept current by the workflows themselves rather than only by manual saves.

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

### Knowledge accumulation

Knowledge grows continuously:
- `/my-assistant-update` — run once to import all past sessions, then periodically for new ones
- `/my-assistant-save` — checkpoint mid-session or before closing
- `/my-assistant-task` — automatically saves task results after each completed task
- `/my-assistant` — proactively saves when it detects significant moments during conversation

All saves are **append-only** — existing knowledge is never overwritten or deleted.

---

## Install

**Windows (PowerShell):**
```powershell
git clone https://github.com/ahmedelwakil/my-claude-assistant
cd my-claude-assistant
.\install.ps1
```

**macOS / Linux / WSL:**
```bash
git clone https://github.com/ahmedelwakil/my-claude-assistant
cd my-claude-assistant
chmod +x install.sh && ./install.sh
```

Restart Claude Code after installing. Skills are available immediately as slash commands.

---

## First run

1. Open Claude Code in any directory
2. Run `/my-assistant-update` — point it to your Claude session transcript directory:
   - **Windows:** `C:\Users\<username>\AppData\Local\Temp\claude`
   - **macOS:** `~/Library/Caches/claude-code/projects`
   - **Linux/WSL:** `/tmp/claude` or `~/.local/share/claude`
3. Let it process your sessions and build `~/.claude/my-assistant/base-knowledge.md`
4. Run `/my-assistant` to start your first session

---

## Data directory (knowledge + runtime state)

Knowledge and runtime state live in a directory you configure (default `~/claude workspace/my-assistant/`) — separate from this repo, which holds the skills/commands/workflow scripts themselves as the single source of truth:

```
~/claude workspace/my-assistant/
├── base-knowledge.md          — cumulative session history
├── index.md                   — thin cross-cutting index (shared guidelines, project pointers)
├── projects/
│   └── <project-name>.md      — per-project conventions and config
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

---

## Requirements

- [Claude Code](https://claude.ai/code) v2.1.101 or later
- Optional: [Linear MCP connector](https://claude.ai/customize/connectors) for ticket integration

---

## License

MIT
