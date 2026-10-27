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
