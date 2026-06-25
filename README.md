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

### Three knowledge layers

Every `/my-assistant` session loads:

1. **Base knowledge** (`~/.claude/my-assistant/base-knowledge.md`) — a synthesized, cumulative record of everything Claude has helped you with across all past sessions. Built by `/my-assistant-update`, grown by `/my-assistant-save`.
2. **Memory files** (`~/.claude/projects/*/memory/*.md`) — structured notes Claude Code maintains about your projects, preferences, and decisions.
3. **Project structure** — a minimal scan of your project directories (file names only, no content reads).

### Multi-agent task workflow

When `/my-assistant` detects a technical task, it offers the full workflow. Tasks can be handed off as:
- A **Linear ticket ID** — full ticket context fetched automatically
- A **file + line reference** — investigation starts from there
- A **free text description** — clarified before planning

The workflow runs up to 5 agents:

| Agent | Role |
|---|---|
| Main | Plans, executes steps, gates |
| Intent & Conventions | Reviews against task intent and project conventions |
| Test Writer | Writes tests for the detected test runner |
| Coverage Reviewer | Reviews test coverage for gaps |
| Architecture (conditional) | Flags structural violations and tech debt |

Five supervision modes let you control how much you stay in the loop — from gating every file write to fully autonomous execution with escalation only on conflicts.

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

## Centralized data directory

All assistant data lives in `~/.claude/my-assistant/`:

```
~/.claude/my-assistant/
├── base-knowledge.md          — cumulative session history
├── projects/
│   └── <project-name>.md      — per-project conventions and config
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
