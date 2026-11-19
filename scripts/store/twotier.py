#!/usr/bin/env python3
"""Two-tier conversion prototype: split each long decision into a short rule line plus a `detail:` line,
and each long open item into a short title line plus a `detail:` line.

The conversion is lossless by construction and verified: rule + detail must rebuild the original text exactly.
Run on a COPY of the data directory; this script never edits its input in place.

  python twotier.py --in FILE --out FILE [--rule-max 240] [--item-max 200]
"""
import argparse
import re
import sys

ENTRY = re.compile(r'^(- (?:D|A)-\d+(?: \[pin\])?) (.*)$')
ITEM = re.compile(r'^(- \[[ x]\]) (.*)$')


def split_text(text, limit):
    """Return (rule, detail). Cut at a sentence end outside backticks and parentheses, at or below limit."""
    if len(text) <= limit:
        return text, ''
    depth, tick, best = 0, False, -1
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
            best = i + 1
    if best < 40:
        # no clean sentence end: cut at the last space before the limit
        best = text.rfind(' ', 0, limit)
        if best < 40:
            return text, ''
    return text[:best].rstrip(), text[best:].lstrip()


def convert(src, rule_max, item_max):
    out, stats = [], {'entries': 0, 'split_entries': 0, 'rule_bytes': 0, 'detail_bytes': 0,
                      'items': 0, 'split_items': 0, 'title_bytes': 0, 'item_detail_bytes': 0, 'lossless': True}
    in_decisions = in_items = False
    for line in src.split('\n'):
        if line.startswith('## '):
            in_decisions = line.startswith('## 3.')
            in_items = line.startswith('## 4.')
        m = ENTRY.match(line)
        if m and not in_items:
            head, text = m.groups()
            rule, detail = split_text(text, rule_max)
            stats['entries'] += 1
            stats['rule_bytes'] += len(rule.encode())
            if detail:
                stats['split_entries'] += 1
                stats['detail_bytes'] += len(detail.encode())
            if (rule + (' ' + detail if detail else '')) != text:
                stats['lossless'] = False
            out.append(head + ' ' + rule)
            if detail:
                out.append('  detail: ' + detail)
            continue
        m = ITEM.match(line) if in_items else None
        if m:
            head, text = m.groups()
            title, detail = split_text(text, item_max)
            stats['items'] += 1
            stats['title_bytes'] += len(title.encode())
            if detail:
                stats['split_items'] += 1
                stats['item_detail_bytes'] += len(detail.encode())
            if (title + (' ' + detail if detail else '')) != text:
                stats['lossless'] = False
            out.append(head + ' ' + title)
            if detail:
                out.append('  detail: ' + detail)
            continue
        out.append(line)
    return '\n'.join(out), stats


def rebuild(converted):
    """Inverse: fold `  detail:` lines back into the line above. Used to prove the conversion is lossless."""
    out = []
    for line in converted.split('\n'):
        if line.startswith('  detail: ') and out and (ENTRY.match(out[-1]) or ITEM.match(out[-1])):
            out[-1] = out[-1] + ' ' + line[len('  detail: '):]
        else:
            out.append(line)
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--rule-max', type=int, default=240)
    ap.add_argument('--item-max', type=int, default=200)
    a = ap.parse_args()
    src = open(a.inp, encoding='utf-8', newline='').read().replace('\r\n', '\n')
    conv, st = convert(src, a.rule_max, a.item_max)
    exact = rebuild(conv) == src
    open(a.out, 'w', encoding='utf-8', newline='').write(conv)
    total = len(src.encode())
    print('%s: %d KB -> %d KB loaded-part; decisions %d (%d split; rule %d B, detail %d B); items %d (%d split; title %d B, detail %d B); rebuild exact: %s; per-entry lossless: %s'
          % (a.inp.replace('\\', '/').split('/')[-1], total // 1024, (total - st['detail_bytes'] - st['item_detail_bytes']) // 1024,
             st['entries'], st['split_entries'], st['rule_bytes'], st['detail_bytes'],
             st['items'], st['split_items'], st['title_bytes'], st['item_detail_bytes'], exact, st['lossless']))
    return 0 if exact and st['lossless'] else 1


if __name__ == '__main__':
    sys.exit(main())
