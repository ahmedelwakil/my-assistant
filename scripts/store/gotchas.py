#!/usr/bin/env python3
"""Convert the bullets of `## 5. Conventions and gotchas` into indexed gotcha entries (G-nnn).

Each bullet becomes:
  - G-nnn <short title>
    triggers: <words> | noted: <earliest ISO date in the text, or the conversion date>
    detail: <the original bullet text, verbatim>
(the trigger line sits directly under the title so one `Grep -A 1 "^- G-"` returns the title and its triggers)
Nothing is rewritten or dropped: the original text is the detail, so the conversion is lossless by construction
and verified (rebuilding each bullet from its detail must equal the original). Titles and trigger words come
from a proposals file (a JSON list in bullet order: {"i", "title", "triggers"}).

  python gotchas.py --in FILE --proposals FILE --out FILE [--today YYYY-MM-DD]
"""
import argparse
import json
import re
import sys

ISO = re.compile(r'\d{4}-\d{2}-\d{2}')


def convert(text, proposals, today):
    m = re.search(r'(?ms)^(## 5\. Conventions and gotchas\n)(.*?)(?=^## 6\.)', text)
    if not m:
        raise SystemExit('section 5 not found')
    body = m.group(2)
    lines = body.split('\n')
    bullets = [l for l in lines if l.startswith('- ')]
    others = [l for l in lines if l.strip() and not l.startswith('- ')]
    if others:
        raise SystemExit('section 5 has non-bullet lines, refusing: %r' % others[0][:60])
    if any(re.match(r'^- G-\d+\b', l) for l in bullets):
        raise SystemExit('section 5 already has G- entries, refusing')
    if len(bullets) != len(proposals):
        raise SystemExit('%d bullets but %d proposals' % (len(bullets), len(proposals)))
    out, orig = [], []
    for n, (line, p) in enumerate(zip(bullets, proposals), 1):
        original = line[2:]
        title = ' '.join(p['title'].split())
        trig = [t.strip() for t in p['triggers'] if t.strip() and ',' not in t and '|' not in t]
        if not title or len(title) > 200 or len(trig) < 3:
            raise SystemExit('bad proposal for bullet %d' % n)
        dates = ISO.findall(original)
        noted = min(dates) if dates else today
        out += ['- G-%03d %s' % (n, title), '  triggers: %s | noted: %s' % (', '.join(trig), noted), '  detail: ' + original]
        orig.append(original)
    new_body = '\n'.join(out) + '\n\n'
    result = text[:m.start(2)] + new_body + text[m.end(2):]
    return result, orig


def verify(result, orig):
    """Rebuild every bullet from its detail line and compare with the original list."""
    m = re.search(r'(?ms)^## 5\. Conventions and gotchas\n(.*?)(?=^## 6\.)', result)
    details = re.findall(r'(?m)^  detail: (.*)$', m.group(1))
    return details == orig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--proposals', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--today', default='2026-11-19')
    a = ap.parse_args()
    with open(a.inp, encoding='utf-8', newline='') as fh:
        text = fh.read().replace('\r\n', '\n')
    with open(a.proposals, encoding='utf-8') as fh:
        proposals = json.load(fh)
    result, orig = convert(text, proposals, a.today)
    ok = verify(result, orig)
    removed = [o for o in orig if o not in result]
    with open(a.out, 'w', encoding='utf-8', newline='') as fh:
        fh.write(result)
    print('%d gotchas; section 5 %d -> %d bytes; originals preserved verbatim: %s; missing from result: %d'
          % (len(orig), len(text.encode()), len(result.encode()), ok, len(removed)))
    return 0 if ok and not removed else 1


if __name__ == '__main__':
    sys.exit(main())
