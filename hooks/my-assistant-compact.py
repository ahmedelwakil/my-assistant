#!/usr/bin/env python3
"""SessionStart hook (matcher: compact) for my-assistant.

After a context compaction, re-inject the standing rules (pinned R- entries of
domains/global.md) and the pinned D-/A- entries of the active domain, so the
assistant keeps them without a re-read. Reads from disk only; never writes.
Output: SessionStart JSON on stdout, capped below the 10,000 character hook limit.
Optional arg: --domain <name> overrides state/active-session.json (testing).
"""
import json, os, re, sys

CAP = 9500


def data_dir():
    pointer = os.path.join(os.path.expanduser("~"), ".claude", "my-assistant", "config-location")
    cfg_path = json.load(open(pointer, encoding="utf-8"))["configPath"]
    return json.load(open(cfg_path, encoding="utf-8"))["dataDir"]


def entries(text, pinned_only):
    """Yield (id, first line) for entries; a first line is the rule itself."""
    out = []
    for m in re.finditer(r"(?m)^- ((?:R|D|A)-\d+)( \[pin\])? (.*)$", text):
        if pinned_only and not m.group(2):
            continue
        rule = re.sub(r"\s+", " ", m.group(3)).strip()
        out.append("%s %s" % (m.group(1), rule))
    return out


def read(path):
    try:
        return open(path, encoding="utf-8").read()
    except OSError:
        return ""


def main():
    dd = data_dir()
    domain = None
    if "--domain" in sys.argv:
        domain = sys.argv[sys.argv.index("--domain") + 1]
    else:
        try:
            domain = json.load(open(os.path.join(dd, "state", "active-session.json"), encoding="utf-8")).get("domain")
        except (OSError, ValueError):
            domain = None

    g = read(os.path.join(dd, "domains", "global.md"))
    g = g.split("## Global notes")[0]
    parts = ["my-assistant context restored after compaction (from disk; re-read the files for full entries).",
             "STANDING RULES (domains/global.md):"]
    parts += ["- " + e for e in entries(g, True)]
    if domain:
        d = read(os.path.join(dd, "domains", domain + ".md"))
        area = re.search(r"(?m)^area:\s*(\S+)", d)
        parts.append("ACTIVE DOMAIN: %s. Pinned decisions (domains/%s.md):" % (domain, domain))
        parts += ["- " + e for e in entries(d.split("## 4. Open items")[0], True)]
        if area:
            a = read(os.path.join(dd, "domains", area.group(1) + ".area.md"))
            parts.append("AREA RULES (%s.area.md):" % area.group(1))
            parts += ["- " + e for e in entries(a, True)]
        parts.append("Re-read domains/%s.md (and its area file) before any plan or external action." % domain)
    else:
        parts.append("No active domain recorded; if the session was about a project, re-load it with /my-assistant <domain>.")
    text = "\n".join(parts)
    if len(text) > CAP:
        text = text[: CAP - 80].rsplit("\n", 1)[0] + "\n[truncated: re-read domains/global.md]"
    json.dump({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, sys.stdout)


if __name__ == "__main__":
    main()
