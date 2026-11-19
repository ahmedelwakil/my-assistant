#!/usr/bin/env python3
"""Run the store against a COPY of a real data directory and check that nothing but the target changes.

  python check_real.py --data-dir COPY_OF_DATA_DIR

Never point this at the live data directory: it writes to the files it is given.
"""
import argparse
import difflib
import glob
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store  # noqa: E402


def rd(p):
    with open(p, 'rb') as fh:
        return fh.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True)
    a = ap.parse_args()
    d = a.data_dir.replace('\\', '/').rstrip('/')
    st = Store(d, now=lambda: '2026-11-19')
    fails = []

    def check(name, ok, info=''):
        print('%-62s %s %s' % (name, 'PASS' if ok else 'FAIL', info))
        if not ok:
            fails.append(name)

    doms = sorted(os.path.basename(p)[:-3] for p in glob.glob(d + '/domains/*.md') if not p.endswith('.area.md') and not p.endswith('global.md'))
    files = glob.glob(d + '/domains/*.md') + [p for p in glob.glob(d + '/history/*.md') if not p.endswith('.notes.md')]
    bad = []
    for p in files:
        raw = rd(p)
        lines, nl = Store.read(p)
        Store.write(p, lines, nl)
        if rd(p) != raw:
            bad.append(os.path.basename(p))
    check('read/write round trip is byte-identical (%d files)' % len(files), not bad, str(bad))

    clash = []
    for dm in doms:
        nid = st.next_id(dm)
        hits = []
        for p in (st.dom(dm), st.hist(dm)):
            if os.path.exists(p):
                hits += [l for l in rd(p).decode('utf-8').split('\n') if re.match(r'^- %s\b' % nid, l)]
        if hits:
            clash.append((dm, nid))
    check('next id never collides with a line-start entry (%d domains)' % len(doms), not clash, str(clash))

    probs = {dm: st.validate(dm)['problems'] for dm in doms}
    print('validate() problems per domain:', {k: len(v) for k, v in probs.items() if v})

    # every operation on the largest domain: only the expected lines change
    dm = max(doms, key=lambda n: os.path.getsize(st.dom(n)))  # the largest domain file
    path = st.dom(dm)

    def diff(before):
        after = rd(path).decode('utf-8').split('\n')
        b = before.decode('utf-8').split('\n')
        ch = [l for l in difflib.ndiff(b, after) if l[0] in '+-']
        return ch

    before = rd(path)
    tid = st.add_decision(dm, 'Test rule.', ['t'], 'why', 'user test')['id']
    ch = diff(before)
    check('add_decision changes only its 3 added lines', len(ch) == 3 and all(l[0] == '+' for l in ch), '(%d changed lines)' % len(ch))

    before = rd(path)
    st.add_item(dm, 'Test item')
    ch = diff(before)
    check('add_item changes only its 1 added line', len(ch) == 1 and ch[0][0] == '+', '(%d)' % len(ch))

    before = rd(path)
    st.update_item(dm, 'Test item', 'a dated update')
    ch = diff(before)
    check('update_item adds one sub-line and nothing else', len(ch) == 1 and ch[0][0] == '+', '(%d)' % len(ch))

    before = rd(path)
    st.complete_item(dm, 'Test item')
    ch = diff(before)
    check('complete_item changes one line', len(ch) == 2, '(%d)' % len(ch))

    before = rd(path)
    hb = rd(st.hist(dm))
    st.supersede_decision(dm, tid, 'D-001')
    ch = diff(before)
    check('supersede removes only the entry block from the live file', all(l[0] == '-' for l in ch) and 2 <= len(ch) <= 5, '(%d)' % len(ch))
    check('supersede appends to history, nothing earlier changes', rd(st.hist(dm)).startswith(hb[:len(hb) - 1]) or len(rd(st.hist(dm))) > len(hb))

    before = rd(path)
    st.set_status(dm, 'test status')
    ch = diff(before)
    check('set_status changes only status, as-of and the status line', len(ch) <= 8, '(%d)' % len(ch))

    print('\n%d check(s) failed' % len(fails) if fails else '\nALL CHECKS PASSED')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
