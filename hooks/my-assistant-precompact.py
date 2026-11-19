#!/usr/bin/env python3
"""PreCompact hook for my-assistant (matchers: manual and auto).

Before a compaction it (1) copies the session transcript to a backup folder, one file per session that is
overwritten by each compaction, so the full text survives the summary; and (2) prints instructions for the
compaction summary so unsaved decisions, open items and pending approvals are kept.

It NEVER blocks a compaction: every path exits 0 (exit code 2 would block it). Output is plain stdout,
capped well below the 10,000 character hook limit.
Backup folder: config.json "transcriptBackupDir", default <dataDir>/state/transcripts.
Optional args (testing): --backup-dir <dir> overrides the folder.
"""
import json
import os
import re
import shutil
import sys

SAFE = re.compile(r"[^A-Za-z0-9._-]")

INSTRUCTIONS = (
    "When you write this summary, keep these exactly and do not generalise them:\n"
    "- Every decision, rule or correction the user gave in this session that has not yet been saved with /my-assistant-save, in the user's own words where possible.\n"
    "- Open items, pending approvals and anything the user said not to start yet.\n"
    "- The active domain name%s, the ids of any decisions that were discussed (for example D-021), and the exact names of branches, tickets and pull requests in progress.\n"
    "- Anything the user explicitly agreed or declined.\n"
    "The full transcript is backed up, so the summary can be short, but it must not lose these."
)


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def load_config():
    pointer = os.path.join(os.path.expanduser("~"), ".claude", "my-assistant", "config-location")
    cfg_path = json.loads(read(pointer))["configPath"]
    cfg = json.loads(read(os.path.expanduser(cfg_path)))
    return os.path.expanduser(cfg["dataDir"]), cfg


def arg(name):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def backup(transcript, folder, session):
    """Copy atomically: temp file, then replace. Returns True on success."""
    if not transcript or not os.path.isfile(transcript):
        return False
    os.makedirs(folder, exist_ok=True)
    name = SAFE.sub("_", session or "unknown")[:80] or "unknown"
    dst = os.path.join(folder, name + ".jsonl")
    tmp = dst + ".tmp"
    shutil.copyfile(transcript, tmp)
    os.replace(tmp, dst)
    return True


def main():
    domain_note = ""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        data = {}
    try:
        dd, cfg = load_config()
    except Exception:
        dd, cfg = None, {}
    try:
        folder = arg("--backup-dir") or (cfg.get("transcriptBackupDir") and os.path.expanduser(cfg["transcriptBackupDir"])) \
            or (os.path.join(dd, "state", "transcripts") if dd else None)
        if folder:
            backup(data.get("transcript_path"), folder, data.get("session_id"))
    except Exception:
        pass
    try:
        if dd:
            st = json.loads(read(os.path.join(dd, "state", "active-session.json")) or "{}")
            if isinstance(st.get("domain"), str) and re.fullmatch(r"[A-Za-z0-9._-]+", st["domain"]):
                domain_note = " (last recorded: %s)" % st["domain"]
    except Exception:
        pass
    sys.stdout.write(INSTRUCTIONS % domain_note)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException:
        sys.exit(0)
