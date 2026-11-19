#!/usr/bin/env python3
"""Two-tier conversion: split each long NON-PINNED decision into a short rule line plus a `detail:` line,
and each long open item into a short title line plus a `detail:` line.

Pinned decisions are never split (the loader reads them in full from their first line). An item whose short
title loses its date gets ` (as of <latest date in the item>)` appended so its age stays visible; that is the
only text added, and the check below accounts for it exactly. The result is verified before anything is
written: for every entry, rule + detail must equal the original text, and the file with `detail:` lines folded
back must equal the original except for those appended dates.

Run on a backup-protected file; the output goes to a separate path.
  python twotier.py --in FILE --out FILE [--rule-max 240] [--item-max 200]
"""
import argparse
import re
import sys

ENTRY = re.compile(r'^(- (?:D|A)-\d+) (.*)$')
PIN = re.compile(r'^- (?:D|A)-\d+ \[pin\]')
ITEM = re.compile(r'^(- \[[ x]\]) (.*)$')
ISO = re.compile(r'\d{4}-\d{2}-\d{2}')


def boundaries(text, limit):
    """Sentence ends (index after the '.' or ';') outside backticks and parentheses, at or below limit."""
    depth, tick, out = 0, False, []
    for i, ch in enumerate(text):
        if ch == '`':
            tick = not tick
        elif not tick:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth = max(0, depth - 1)
        if i + 1 > limit:
            break
        if ch in '.;' and not tick and depth == 0 and i + 1 < len(text) and text[i + 1] == ' ':
            out.append(i + 1)
    return out


def split_text(text, limit):
    """Return (rule, detail). Prefer a clean sentence end within limit, then within twice the limit."""
    if len(text) <= limit:
        return text, ''
    for lim in (limit, limit * 2):
        b = [x for x in boundaries(text, lim) if x >= 40]
        if b:
            cut = b[-1] if lim == limit else b[0]
            if cut < len(text) - 1:
                return text[:cut].rstrip(), text[cut:].lstrip()
    cut = text.rfind(' ', 0, limit)
    if cut < 40:
        return text, ''
    return text[:cut].rstrip(), text[cut:].lstrip()


def convert(src, rule_max, item_max):
    out, st = [], {'entries': 0, 'split_entries': 0, 'rule_bytes': 0, 'detail_bytes': 0, 'skipped_pinned': 0,
                   'items': 0, 'split_items': 0, 'title_bytes': 0, 'item_detail_bytes': 0, 'dates_added': 0, 'lossless': True}
    in_items = False
    for line in src.split('\n'):
        if line.startswith('## '):
            in_items = line.startswith('## 4.')
        m = ENTRY.match(line)
        if m and not in_items:
            head, text = m.groups()
            if PIN.match(line):
                st['skipped_pinned'] += 1
                out.append(line)
                continue
            rule, detail = split_text(text, rule_max)
            st['entries'] += 1
            st['rule_bytes'] += len(rule.encode())
            if detail:
                st['split_entries'] += 1
                st['detail_bytes'] += len(detail.encode())
            if (rule + (' ' + detail if detail else '')) != text:
                st['lossless'] = False
            out.append(head + ' ' + rule)
            if detail:
                out.append('  detail: ' + detail)
            continue
        m = ITEM.match(line) if in_items else None
        if m:
            head, text = m.groups()
            title, detail = split_text(text, item_max)
            if len(title) > 320:  # a long first sentence: cut at a space so the title stays short
                cut = title.rfind(' ', 0, 300)
                if cut > 40:
                    detail = (title[cut:].lstrip() + (' ' + detail if detail else '')).strip()
                    title = title[:cut].rstrip()
            st['items'] += 1
            if (title + (' ' + detail if detail else '')) != text:
                st['lossless'] = False
            if detail and not ISO.search(title):
                dates = ISO.findall(text)
                if dates:
                    title += ' (as of %s)' % max(dates)
                    st['dates_added'] += 1
            st['title_bytes'] += len(title.encode())
            if detail:
                st['split_items'] += 1
                st['item_detail_bytes'] += len(detail.encode())
            out.append(head + ' ' + title)
            if detail:
                out.append('  detail: ' + detail)
            continue
        out.append(line)
    return '\n'.join(out), st


def rebuild(converted):
    """Fold `  detail:` lines back into the line above (the inverse of the split)."""
    out = []
    for line in converted.split('\n'):
        if line.startswith('  detail: ') and out and (ENTRY.match(out[-1]) or ITEM.match(out[-1])):
            out[-1] = out[-1] + ' ' + line[len('  detail: '):]
        else:
            out.append(line)
    return '\n'.join(out)


def norm(text):
    """Remove every ` (as of YYYY-MM-DD)` token: the only text the converter may add."""
    return re.sub(r' \(as of \d{4}-\d{2}-\d{2}\)', '', text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--rule-max', type=int, default=240)
    ap.add_argument('--item-max', type=int, default=200)
    a = ap.parse_args()
    with open(a.inp, encoding='utf-8', newline='') as fh:
        src = fh.read().replace('\r\n', '\n')
    conv, st = convert(src, a.rule_max, a.item_max)
    exact = norm(rebuild(conv)) == norm(src)
    with open(a.out, 'w', encoding='utf-8', newline='') as fh:
        fh.write(conv)
    total = len(src.encode())
    print('%s: %d KB -> %d KB; decisions %d (%d split, %d pinned left whole; rule %d B, detail %d B); items %d (%d split; title %d B, detail %d B; %d dates appended); rebuild exact: %s; per-entry lossless: %s'
          % (a.inp.replace('\\', '/').split('/')[-1], total // 1024, len(conv.encode()) // 1024,
             st['entries'], st['split_entries'], st['skipped_pinned'], st['rule_bytes'], st['detail_bytes'],
             st['items'], st['split_items'], st['title_bytes'], st['item_detail_bytes'], st['dates_added'], exact, st['lossless']))
    return 0 if exact and st['lossless'] else 1


if __name__ == '__main__':
    sys.exit(main())
