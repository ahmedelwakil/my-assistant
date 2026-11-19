# Compaction hook (optional, not installed by install.ps1/install.sh)

`my-assistant-compact.py` re-injects the pinned standing rules (`domains/global.md`) and the active domain's pinned decisions after a context compaction. It only reads from disk, never writes, and prints one SessionStart JSON object (about 4-6 KB; the hook limit is 10,000 characters).

The active domain comes from `<dataDir>/state/active-session.json`, which `/my-assistant` writes when it deep-loads a domain.

## Enable it (explicit user decision: it edits `~/.claude/settings.json`)

Add this to the `hooks` section of `~/.claude/settings.json` (merge with existing `SessionStart` entries, do not replace them; forward slashes work on Windows):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          { "type": "command", "command": "python -X utf8 \"<path-to-this-repo>/hooks/my-assistant-compact.py\"" }
        ]
      }
    ]
  }
}
```

Test: `python -X utf8 hooks/my-assistant-compact.py --domain <name>` prints the JSON; then run `/compact` in a session after `/my-assistant <name>` and ask which rules are active.

## Notes

- Namespaces: if the active session is inside a namespace (`config.json` `namespaces`), `/my-assistant` records it in `active-session.json` and the hook restores that namespace's domain pins; global rules always come from the default tree.
- If `python` is not on your PATH (some Windows installs only have the launcher), use `py -3 -X utf8 "<path-to-this-repo>/hooks/my-assistant-compact.py"` as the command.
- The hook never fails a session: on a missing or broken config it prints a one-line hint telling you to re-run `/my-assistant`.
- Test it: `python -X utf8 hooks/my-assistant-compact.py --domain <name> [--namespace <name>]`.

## Pre-compaction hook (`my-assistant-precompact.py`)

Runs before every compaction (manual and automatic). It copies the session transcript to a backup folder (one file per session, overwritten by each compaction, so the full text survives the summary) and prints instructions that Claude Code adds to the compaction summary: keep unsaved decisions, open items, pending approvals, the active domain and the ids and names in progress.

It never blocks a compaction (it always exits 0; exit code 2 would block it), never raises, and cannot write outside its backup folder. The backup folder is `transcriptBackupDir` in `config.json`, default `<dataDir>/state/transcripts` (transcripts are large, tens of megabytes; point it at a folder with space).

Add to the `hooks` section of `~/.claude/settings.json` (an explicit user decision, it edits that file):

```json
"PreCompact": [
  { "hooks": [ { "type": "command", "command": "python -X utf8 \"<path-to-this-repo>/hooks/my-assistant-precompact.py\"" } ] }
]
```

Test: `python -X utf8 hooks/test_precompact.py` (set `MA_BIG_TRANSCRIPT` to a large transcript to time the copy). The hook receives `session_id`, `transcript_path` and `trigger` on stdin.
