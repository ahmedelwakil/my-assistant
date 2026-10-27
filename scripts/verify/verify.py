#!/usr/bin/env python3
"""Verification checks for a my-assistant data directory and for this repo.

Usage:  python -X utf8 scripts/verify/verify.py <check> [options]
Checks: structure | sources | hook | workflows | privacy | ledger | open-items | all
Run `verify.py --help` for the options. Read-only: it never changes your data or the repo.
Exit code 0 = every check passed, 1 = at least one failed.
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, tempfile

HOME = os.path.expanduser("~")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BS = chr(92)
FAILS = []


def ok(label, cond, detail=""):
    print("  %-62s %s %s" % (label, "PASS" if cond else "FAIL", detail))
    if not cond:
        FAILS.append(label)
    return bool(cond)


def rd(path):
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


# ---------------------------------------------------------------- discovery
def data_dir(arg):
    if arg:
        return os.path.abspath(os.path.expanduser(arg))
    pointer = os.path.join(HOME, ".claude", "my-assistant", "config-location")
    cfg = json.loads(rd(pointer))["configPath"]
    return os.path.expanduser(json.loads(rd(os.path.expanduser(cfg)))["dataDir"])


def namespaces(dd):
    try:
        return json.loads(rd(os.path.join(dd, "config.json"))).get("namespaces", {}) or {}
    except Exception:
        return {}


def memory_dirs(arg):
    if arg:
        return [os.path.abspath(os.path.expanduser(arg))]
    return glob.glob(os.path.join(HOME, ".claude", "projects", "*", "memory"))


def domain_files(dd):
    """(path, namespace-or-None) for every domain file, default tree and namespaces."""
    out = []
    for f in sorted(glob.glob(os.path.join(dd, "domains", "*.md"))):
        n = os.path.basename(f)
        if n == "global.md" or n.endswith(".area.md") or n.startswith("_"):
            continue
        out.append((f, None))
    for ns, conf in namespaces(dd).items():
        sub = (conf or {}).get("path", ns)
        if sub in (".", "", "./"):
            continue  # the default namespace is the tree already scanned above
        for f in sorted(glob.glob(os.path.join(dd, sub, "domains", "*.md"))):
            n = os.path.basename(f)
            if n != "global.md" and not n.endswith(".area.md") and not n.startswith("_"):
                out.append((f, ns))
    return out


def open_items(text):
    """Unchecked items (`- [ ]`) in the '## 4. Open items' section."""
    m = re.search(r"(?ms)^## 4\. Open items\s*$(.*?)(?=^## 5\.|\Z)", text)
    return re.findall(r"(?m)^- \[ \] .*$", m.group(1)) if m else []


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return m.group(1) if m else ""


def fm(text, key):
    m = re.search(r"(?m)^%s:\s*(.*)$" % re.escape(key), frontmatter(text))
    return m.group(1).strip() if m else None


# ---------------------------------------------------------------- checks
def check_structure(a):
    print("structure")
    dd = data_dir(a.data_dir)
    files = domain_files(dd)
    ok("domain files found", bool(files), "%d files" % len(files))
    sections = ["## 1. Context", "## 2. Status", "## 3. Live decisions", "## 4. Open items", "## 5. Conventions", "## 6. Pointers"]
    for f, ns in files:
        name = os.path.relpath(f, dd)
        t = rd(f)
        keys = ["domain", "area", "lifecycle", "namespace", "sensitive", "status", "as-of"]
        miss = [k for k in keys if fm(t, k) is None]
        ok("%s: frontmatter" % name, not miss, "missing %s" % miss if miss else "")
        ok("%s: six sections" % name, all(s in t for s in sections))
        st = fm(t, "status") or ""
        ok("%s: status <= 130 chars" % name, len(st) <= 130, "%d" % len(st))
        ids = re.findall(r"(?m)^- (D-\d+)", t)
        ok("%s: unique decision ids" % name, len(ids) == len(set(ids)))
        undated = [l[:50] for l in open_items(t) if not re.search(r"\d{4}-\d{2}-\d{2}", l)]
        ok("%s: every open item carries a date" % name, not undated, "%d undated" % len(undated) if undated else "")
        bad = []
        for e in re.split(r"(?m)^(?=- D-\d+)", t)[1:]:
            head = e.split("\n", 1)[0]
            if "superseded" in head[:60].lower() or "retired" in head[:60].lower():
                continue
            if "triggers:" not in e or "src:" not in e:
                bad.append(head[:12])
        ok("%s: triggers and src on every decision" % name, not bad, str(bad) if bad else "")
        # a placeholder is a src that IS the word ("src: same" ending the line), not text that quotes it
        ok("%s: no placeholder src" % name, not re.search(r"(?im)(?<![`'\"])\bsrc:\s*(same|ditto|above|tbd|n/a)\s*$", t))
        if "\r\n" in open(f, encoding="utf-8", newline="").read():
            print("  note: %s uses Windows line endings (harmless, but mixed trees confuse regexes)" % name)
    g = os.path.join(dd, "domains", "global.md")
    if os.path.exists(g):
        gt = rd(g)
        rid = re.findall(r"(?m)^- (R-\d+)", gt)
        ok("global.md: unique rule ids", len(rid) == len(set(rid)))
        ok("global.md: has the Global notes heading", "## Global notes" in gt)
        lines = re.findall(r"(?m)^- R-\d+ \[pin\] .*$", gt)
        total = sum(len(x) + 1 for x in lines)
        ok("global.md: pinned rule lines under ~4,500 chars", total <= 4600, "%d chars, %d rules" % (total, len(lines)))


def check_sources(a):
    print("sources (src: pointers resolve)")
    dd = data_dir(a.data_dir)
    mems = memory_dirs(a.memory_dir)
    memnames = set()
    for m in mems:
        for f in os.listdir(m):
            if f.endswith(".md"):
                memnames.add(os.path.splitext(f)[0])
    roots = [dd] + [os.path.join(dd, (c or {}).get("path", n)) for n, c in namespaces(dd).items()]
    files = [p for p, _ in domain_files(dd)] + glob.glob(os.path.join(dd, "domains", "*.md"))
    stats = dict(srcs=0, mem_bad=0, hist_bad=0, head_bad=0)
    problems = []
    for f in sorted(set(files)):
        for ln, line in enumerate(rd(f).split("\n"), 1):
            m = re.search(r"\bsrc:\s*(.*)$", line)
            if not m:
                continue
            stats["srcs"] += 1
            seg = m.group(1)
            for nm in re.findall(r"memory/([A-Za-z0-9_\-]+)", seg):
                if not (nm in memnames or nm.replace("-", "_") in memnames):
                    stats["mem_bad"] += 1
                    problems.append("%s:%d memory file missing: %s" % (os.path.basename(f), ln, nm))
            for path, rest in re.findall(r'(history/[A-Za-z0-9_.\-]+\.md)((?:\s*"[^"]+"(?:\s*,\s*"[^"]+")*)?)', seg):
                text = None
                for r in roots:
                    p = os.path.join(r, path)
                    if os.path.exists(p):
                        text = rd(p)
                        break
                if text is None:
                    stats["hist_bad"] += 1
                    problems.append("%s:%d history file missing: %s" % (os.path.basename(f), ln, path))
                    continue
                for h in re.findall(r'"([^"]+)"', rest):
                    key = h.strip().strip("`")[:28].lower()
                    if key and key not in text.lower():
                        stats["head_bad"] += 1
                        problems.append('%s:%d heading not found in %s: "%s"' % (os.path.basename(f), ln, path, h[:40]))
    ok("%d src pointers checked" % stats["srcs"], not problems, "%d problems" % len(problems))
    for p in problems[:15]:
        print("    " + p)


def check_hook(a):
    print("hook")
    hook = os.path.join(REPO, "hooks", "my-assistant-compact.py")
    if not os.path.exists(hook):
        return ok("hook script present", False, hook)

    def run(home, args=()):
        env = dict(os.environ, USERPROFILE=home, HOME=home)
        r = subprocess.run([sys.executable, "-X", "utf8", hook] + list(args), capture_output=True, text=True, env=env)
        try:
            t = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        except Exception:
            t = None
        return r.returncode, t

    h1 = tempfile.mkdtemp()
    rc, t = run(h1)
    ok("missing config -> exit 0 with a hint", rc == 0 and t is not None)
    h2 = tempfile.mkdtemp()
    os.makedirs(h2 + "/.claude/my-assistant")
    open(h2 + "/.claude/my-assistant/config-location", "w").write(json.dumps({"configPath": h2 + "/cfg.json"}))
    open(h2 + "/cfg.json", "w").write("{not json")
    rc, t = run(h2)
    ok("malformed config -> exit 0 with a hint", rc == 0 and t is not None)
    h3 = tempfile.mkdtemp()
    dd = h3 + "/data"
    for d in ("domains", "state", "ns/domains"):
        os.makedirs(dd + "/" + d)
    os.makedirs(h3 + "/.claude/my-assistant")
    open(h3 + "/.claude/my-assistant/config-location", "w").write(json.dumps({"configPath": h3 + "/cfg.json"}))
    open(h3 + "/cfg.json", "w").write(json.dumps({"dataDir": dd, "namespaces": {"ns": {"path": "ns"}}}))
    open(dd + "/domains/global.md", "w").write("- R-001 [pin] rule one\n## Global notes\n- R-002 [pin] not restored\n")
    open(dd + "/secret.md", "w").write("- D-001 [pin] TRAVERSAL-LEAK\n")
    open(dd + "/domains/proj.md", "w").write("---\ndomain: proj\narea: x\n---\n## 3. Live decisions\n- D-001 [pin] PROJ-RULE\n## 4. Open items\n- D-002 [pin] NOT-IN-DECISIONS\n")
    open(dd + "/ns/domains/inns.md", "w").write("---\ndomain: inns\narea: x\n---\n## 3. Live decisions\n- D-001 [pin] NS-RULE\n## 4. Open items\n")
    rc, t = run(h3, ["--domain", "../secret"])
    ok("path traversal is rejected", rc == 0 and "TRAVERSAL-LEAK" not in (t or ""))
    rc, t = run(h3, ["--domain", "proj"])
    ok("pins come from section 3 only, notes not restored", "PROJ-RULE" in t and "NOT-IN-DECISIONS" not in t and "not restored" not in t)
    rc, t = run(h3, ["--domain", "inns", "--namespace", "ns"])
    ok("namespaced domain is restored", "NS-RULE" in t)
    for d in (h1, h2, h3):
        shutil.rmtree(d, ignore_errors=True)


def wrap_js(src):
    return "async function __wf(args, agent, parallel, pipeline, phase, workflow, budget){\n" + src.replace("export const meta", "const meta", 1) + "\n}\n"


def check_workflows(a):
    print("workflows")
    node = shutil.which("node")
    if not node:
        return ok("node is installed (needed for this check)", False)
    files = sorted(glob.glob(os.path.join(REPO, "workflows", "*.js")) + glob.glob(os.path.join(REPO, "workflows", "dispatch", "*.js")))
    tmp = tempfile.mkdtemp()
    for f in files:
        p = os.path.join(tmp, "x.js")
        open(p, "w", encoding="utf-8").write(wrap_js(rd(f)))
        r = subprocess.run([node, "--check", p], capture_output=True, text=True)
        ok("%s: syntax" % os.path.relpath(f, REPO).replace(BS, "/"), r.returncode == 0, r.stderr.splitlines()[0][:80] if r.returncode else "")
    # evaluate every path constant: a syntax check cannot see a dropped backslash
    for f in files:
        consts = [l for l in rd(f).splitlines() if re.match(r"const [A-Z_]+ = [`']", l) and ("dataDir" in l or re.search(r"\$\{[A-Z_]+\}", l))]
        if not consts:
            continue
        names = [re.match(r"const ([A-Z_]+)", l).group(1) for l in consts]
        js = "const A={dataDir:'D:/data'}; const config={dataDir:'D:/data'};\n" + "\n".join(consts) + "\nconst out={};\n"
        js += "".join("try{out['%s']=%s}catch(e){out['%s']='ERR '+e.message}\n" % (n, n, n) for n in names) + "console.log(JSON.stringify(out))\n"
        p = os.path.join(tmp, "t.js")
        open(p, "w").write(js)
        r = subprocess.run([node, p], capture_output=True, text=True)
        try:
            res = json.loads(r.stdout)
        except Exception:
            ok("%s: path constants evaluate" % os.path.basename(f), False, r.stderr[:80])
            continue
        bad = {k: v for k, v in res.items() if isinstance(v, str) and (v.startswith("ERR") or re.match(r"^D:/data[A-Za-z]", v))}
        ok("%s: path constants are well formed" % os.path.basename(f), not bad, str(bad)[:100] if bad else "")
    shutil.rmtree(tmp, ignore_errors=True)


def check_privacy(a):
    print("privacy (public repo)")
    words = [w.strip() for w in (a.deny or os.environ.get("MY_ASSISTANT_DENY", "")).split(",") if w.strip()]
    deny_file = os.path.join(os.path.dirname(__file__), "deny.txt")
    if os.path.exists(deny_file):
        words += [l.strip() for l in rd(deny_file).splitlines() if l.strip() and not l.startswith("#")]
    pats = [re.compile(r"[A-Za-z]:" + re.escape(BS) + "Users" + re.escape(BS) + r"(?!<)[^\s" + re.escape(BS) + r"`]+", re.I),
            re.compile(r"/Users/(?!<)[A-Za-z0-9._-]+"), re.compile(r"/home/(?!<)[A-Za-z0-9._-]+")]
    pats += [re.compile(re.escape(w), re.I) for w in words]
    ok("deny-list supplied (--deny, MY_ASSISTANT_DENY or scripts/verify/deny.txt)", bool(words), "%d words" % len(words))
    try:
        listed = subprocess.run(["git", "-C", REPO, "ls-files"], capture_output=True, text=True).stdout.split("\n")
    except Exception:
        listed = []
    files = [os.path.join(REPO, p) for p in listed if p and p.endswith((".md", ".js", ".py", ".ps1", ".sh", ".json"))]
    hits = []
    for f in files:
        rel = os.path.relpath(f, REPO).replace(BS, "/")
        if rel.startswith("scripts/verify/"):
            continue
        try:
            for n, line in enumerate(rd(f).split("\n"), 1):
                line = re.sub(r"https?://\S+", "", line)  # the repo's own URLs are expected to carry its owner name
                if any(p.search(line) for p in pats):
                    hits.append("%s:%d" % (rel, n))
        except OSError:
            pass
    ok("no private names or personal paths in %d tracked files" % len(files), not hits, "%d hits" % len(hits))
    for h in hits[:15]:
        print("    " + h)


def check_ledger(a):
    print("ledger (optional: legacy ledger blocks preserved in history/)")
    if not a.ledger:
        print("  skipped (pass --ledger <legacy base-knowledge.md>)")
        return
    dd = data_dir(a.data_dir)
    blocks = re.split(r"(?m)^(?=### Session)", rd(a.ledger))[1:]
    hist = "".join(rd(f) for f in glob.glob(os.path.join(dd, "history", "*.md")) if not f.endswith(".notes.md"))
    missing = [b.split("\n", 1)[0][:60] for b in blocks if b.rstrip("\n") not in hist]
    ok("%d legacy session blocks found verbatim in history/*.md" % len(blocks), not missing, "%d missing" % len(missing))


def check_open_items(a):
    """Report open items by age. Informational: it fails only with --strict (undated, or older than 90 days)."""
    import datetime
    print("open items (age report; the date used is the latest ISO date in each item)")
    dd = data_dir(a.data_dir)
    today = datetime.date.fromisoformat(a.today) if a.today else datetime.date.today()
    tot = undated = o30 = o90 = unver = 0
    rows = []
    for f, ns in domain_files(dd):
        name = os.path.relpath(f, dd)
        for l in open_items(rd(f)):
            tot += 1
            ds = re.findall(r"\d{4}-\d{2}-\d{2}", l)
            if re.search(r"unverified|check live|re-check live|ask the user", l, re.I):
                unver += 1
            if not ds:
                undated += 1
                rows.append((name, "UNDATED", l[:80]))
                continue
            age = (today - datetime.date.fromisoformat(max(ds))).days
            if age > 30:
                o30 += 1
                rows.append((name, "%dd" % age, l[:80]))
            if age > 90:
                o90 += 1
    print("  %d open items: %d undated, %d older than 30 days, %d older than 90 days, %d marked unverified" % (tot, undated, o30, o90, unver))
    for r in sorted(rows, key=lambda r: (r[0], r[1]))[:30]:
        print("    %-26s %-8s %s" % r)
    if a.strict:
        ok("no undated open items and none older than 90 days", undated == 0 and o90 == 0)


CHECKS = {"structure": check_structure, "sources": check_sources, "hook": check_hook, "workflows": check_workflows, "privacy": check_privacy, "ledger": check_ledger, "open-items": check_open_items}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("check", choices=list(CHECKS) + ["all"])
    ap.add_argument("--data-dir", help="data directory (default: from ~/.claude/my-assistant/config-location)")
    ap.add_argument("--memory-dir", help="memory directory (default: every ~/.claude/projects/*/memory)")
    ap.add_argument("--deny", help="comma-separated words that must not appear in the repo (privacy check)")
    ap.add_argument("--ledger", help="legacy ledger file to verify against history/ (ledger check)")
    ap.add_argument("--strict", action="store_true", help="open-items check: fail on undated items or items older than 90 days")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD) for the open-items age report")
    a = ap.parse_args()
    for name in (CHECKS if a.check == "all" else [a.check]):
        CHECKS[name](a)
    print("\nALL CHECKS PASSED" if not FAILS else "\n%d CHECK(S) FAILED: %s" % (len(FAILS), "; ".join(FAILS[:8])))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
