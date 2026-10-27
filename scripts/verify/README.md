# verify

Read-only checks for a my-assistant data directory and for this repo. Nothing here changes your data.

```
python -X utf8 scripts/verify/verify.py all --deny "word1,word2"
python -X utf8 scripts/verify/verify.py structure
```

| Check | What it proves |
|---|---|
| `structure` | every domain file has its frontmatter, six sections, a short `status:`, unique IDs, `triggers:` and `src:` on every decision, no placeholder sources; `global.md` pinned rule lines stay small |
| `sources` | every `src:` pointer resolves: the memory file exists, the history file exists, the quoted section heading is really in it |
| `hook` | the compaction hook never fails a session (missing or broken config), rejects path traversal, reads pins from the decisions section only, supports namespaces |
| `workflows` | every workflow script passes a syntax check AND every data-path constant evaluates to a well-formed path (a syntax check alone cannot see a dropped backslash) |
| `privacy` | no personal names, client names or home-directory paths in the tracked files of this public repo |
| `ledger` | (optional) every session block of a legacy single-ledger file is present verbatim in `history/` |

Defaults come from `~/.claude/my-assistant/config-location`. Override with `--data-dir` and `--memory-dir`.

## The privacy check needs your word list

This repo is public, so the words to keep out (repo, client and people names) are NOT stored in it. Supply them with `--deny "a,b,c"`, the `MY_ASSISTANT_DENY` environment variable, or a file `scripts/verify/deny.txt` (one word per line; git-ignored). Home-directory paths are always flagged.

Exit code 0 means every check passed.
