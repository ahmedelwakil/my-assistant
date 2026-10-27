#!/usr/bin/env python3
"""SessionStart hook (matcher: compact) for my-assistant.

After a context compaction, re-inject the standing rules (pinned R- entries of
domains/global.md) and the pinned D-/A- entries of the active domain, so the
assistant keeps them without a re-read. Reads from disk only; never writes.
It never fails the session: on any problem it prints a short hint instead.
Output: SessionStart JSON on stdout, capped below the 10,000 character hook limit.
Optional args: --domain <name> and --namespace <name> override state/active-session.json (testing).
"""
import json, os, re, sys

CAP = 9500
NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def emit(text):
    json.dump({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, sys.stdout)


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


def pinned_entries(text):
    out = []
    for m in re.finditer(r"(?m)^- ((?:R|D|A)-\d+) \[pin\] (.*)$", text):
        out.append("%s %s" % (m.group(1), re.sub(r"\s+", " ", m.group(2)).strip()))
    return out


def decisions_section(text):
    m = re.search(r"(?ms)^## 3\. Live decisions\s*$(.*?)(?=^## 4\.|\Z)", text)
    return m.group(1) if m else text


def main():
    try:
        dd, cfg = load_config()
    except Exception:
        emit("my-assistant: could not read its config (~/.claude/my-assistant/config-location). Re-run /my-assistant to restore the standing rules.")
        return
    domain = arg("--domain")
    ns = arg("--namespace")
    if domain is None:
        try:
            st = json.loads(read(os.path.join(dd, "state", "active-session.json")) or "{}")
            domain = st.get("domain") or None
            ns = st.get("namespace") or None
        except ValueError:
            domain = None
    if domain and not NAME.match(domain):
        domain = None
    if ns and not NAME.match(ns):
        ns = None

    g = read(os.path.join(dd, "domains", "global.md")).split("## Global notes")[0]
    parts = ["my-assistant context restored after compaction (from disk; re-read the files for full entries).",
             "STANDING RULES (domains/global.md):"]
    parts += ["- " + e for e in pinned_entries(g)]
    if domain:
        base = dd
        if ns:
            nspath = (cfg.get("namespaces", {}).get(ns, {}) or {}).get("path", ns)
            base = os.path.join(dd, nspath) if NAME.match(str(nspath)) else dd
        d = read(os.path.join(base, "domains", domain + ".md"))
        where = ("%s/" % ns if ns else "") + "domains/%s.md" % domain
        if d:
            parts.append("ACTIVE DOMAIN: %s. Pinned decisions (%s):" % (domain, where))
            parts += ["- " + e for e in pinned_entries(decisions_section(d))]
            area = re.search(r"(?m)^area:\s*([A-Za-z0-9._-]+)", d)
            if area:
                a = read(os.path.join(base, "domains", area.group(1) + ".area.md"))
                if a:
                    parts.append("AREA RULES (%s.area.md):" % area.group(1))
                    parts += ["- " + e for e in pinned_entries(a)]
            parts.append("Re-read %s (and its area file) before any plan or external action." % where)
        else:
            parts.append("Active domain %s was recorded but its file was not found; re-load it with /my-assistant." % domain)
    else:
        parts.append("No active domain recorded; if the session was about a project, re-load it with /my-assistant <domain>.")
    text = "\n".join(parts)
    if len(text) > CAP:
        text = text[: CAP - 80].rsplit("\n", 1)[0] + "\n[truncated: re-read domains/global.md]"
    emit(text)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit("my-assistant: the restore hook hit an error; re-run /my-assistant to reload the standing rules.")
    sys.exit(0)
