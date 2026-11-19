#!/usr/bin/env python3
"""Read-only audit: find decisions whose trigger words cover little of what the entry says.

For each live decision it extracts distinctive terms from the rule and detail (backticked code terms,
ticket and PR references, UPPER_SNAKE names, CamelCase identifiers) and reports how many of them
appear in the trigger words. Long entries with few triggers, or with low coverage, are listed with the
missing terms as suggestions. Nothing is changed.

  python trigger_audit.py --data-dir DIR [--min-chars 500] [--top 25]
"""
import argparse
import glob
import os
import re
import sys

ENTRY = re.compile(r'^- ((?:D|A)-\d+)\s*(\[pin\])?\s*(.*)$')
TERM = re.compile(r"`([^`]{3,40})`|\b((?:[A-Z]{2,}-\d+)|(?:PR #\d+)|(?:[A-Z][A-Z0-9]+_[A-Z0-9_]+)|(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+))\b")


def parse(path):
    out, cur = [], None
    with open(path, encoding='utf-8', newline='') as fh:
        lines = fh.read().replace('\r\n', '\n').split('\n')
    for line in lines:
        m = ENTRY.match(line)
        if m:
            cur = {'id': m.group(1), 'pin': bool(m.group(2)), 'text': m.group(3), 'triggers': ''}
            out.append(cur)
        elif cur is not None and line.startswith('  detail:'):
            cur['text'] += ' ' + line[len('  detail:'):].strip()
        elif cur is not None and line.startswith('  triggers:'):
            cur['triggers'] = line[len('  triggers:'):].split('|')[0].strip()
        elif line.startswith('## '):
            cur = None
    return out


def terms(text):
    seen, out = set(), []
    for m in TERM.finditer(text):
        t = (m.group(1) or m.group(2)).strip()
        k = t.lower()
        if k not in seen and len(t) >= 3:
            seen.add(k)
            out.append(t)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True)
    ap.add_argument('--min-chars', type=int, default=500)
    ap.add_argument('--top', type=int, default=25)
    a = ap.parse_args()
    rows, n_all = [], 0
    for f in sorted(glob.glob(os.path.join(a.data_dir, 'domains', '*.md'))):
        name = os.path.basename(f)[:-3]
        if name == 'global':
            continue
        for d in parse(f):
            n_all += 1
            ts = terms(d['text'])
            trig = d['triggers'].lower()
            ntrig = len([x for x in d['triggers'].split(',') if x.strip()])
            missing = [t for t in ts if t.lower() not in trig]
            cover = 1 - len(missing) / len(ts) if ts else 1.0
            if len(d['text']) >= a.min_chars and (ntrig <= 5 or cover < 0.35) and missing:
                rows.append((len(d['text']), name, d['id'], ntrig, cover, missing[:6]))
    rows.sort(key=lambda r: (r[4], -r[0]))
    print('%d decisions scanned; %d long entries with thin trigger coverage' % (n_all, len(rows)))
    for ln, dom, i, nt, cov, miss in rows[:a.top]:
        print('%-14s %-7s %5d chars, %d triggers, term coverage %3.0f%%  suggest adding: %s' % (dom, i, ln, nt, cov * 100, ', '.join(miss)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
