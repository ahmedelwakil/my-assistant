#!/usr/bin/env python3
"""Retrieval accuracy test for the knowledge store.

Measures how often a load strategy surfaces the decisions that should apply to a real prompt.
The question set (prompts plus the decisions that should apply) lives in the data directory,
never in this repo, because it names real things.

Subcommands:
  decisions  --data-dir D --domain NAME [--area NAME] --out FILE
             export the live decisions of a domain (and its area file) into a JSON file keyed by domain
  prompts    --projects-dir DIR --out FILE [--min-len 30 --max-len 700 --after YYYY-MM-DD]
             extract real user prompts from session transcripts (*.jsonl) to JSONL
  score      --decisions FILE --gold gold_<domain>.json [...] [--lenient] [--out FILE] [--top-k 5]
             run the strategies against the gold file and print the scores

Question file questions_<domain>.json: [{"id": "q1", "domain": "x", "date": "...", "prompt": "..."}, ...]
Gold file gold_<domain>.json: [{"id": "q1", "sure": ["D-004"], "maybe": ["A-002"], "note": "..."}, ...]
An empty "sure" list means no decision applies (used to measure noise); --lenient also counts "maybe".

Strategies (all deterministic, no model calls):
  pins      pinned decisions only (what a load always has above the 30-decision threshold)
  triggers  pins + decisions whose trigger words appear in the prompt (whole words, phrases)
  fts       pins + the top-k FTS5/BM25 hits over rule text and triggers
  both      pins + trigger matches + fts hits
  all       every decision (upper bound for recall, worst case for noise)
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys

ENTRY = re.compile(r'^- ((?:D|A)-\d+)\s*(\[pin\])?\s*(.*)$')
STOP = set('the a an and or of to in on for with is are be this that it as at by from not no do does did we you i my your our if then else when how what why which can should would could will just also than so but into out up'.split())


def read(p):
    return open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')


def parse_file(path, source):
    """Return decision dicts from one domain or area file (live decisions only)."""
    out, cur = [], None
    for line in read(path).split('\n'):
        m = ENTRY.match(line)
        if m:
            cur = {'id': m.group(1), 'pin': bool(m.group(2)), 'text': m.group(3).strip(), 'triggers': [], 'source': source}
            out.append(cur)
            continue
        if cur is None:
            continue
        if line.startswith('  detail:'):
            cur['text'] += ' ' + line[len('  detail:'):].strip()
        elif line.startswith('  triggers:'):
            t = line[len('  triggers:'):].split('|')[0]
            cur['triggers'] = [x.strip() for x in t.split(',') if x.strip()]
        elif line.startswith('## ') or (line and not line.startswith(' ') and not line.startswith('-')):
            cur = None
    return out


def cmd_decisions(a):
    items = parse_file(os.path.join(a.data_dir, 'domains', a.domain + '.md'), a.domain)
    if a.area:
        items += parse_file(os.path.join(a.data_dir, 'domains', a.area + '.area.md'), a.area)
    store = json.load(open(a.out, encoding='utf-8')) if os.path.exists(a.out) else {}
    store[a.domain] = items
    json.dump(store, open(a.out, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('%s: %d decisions (%d pinned) -> %s' % (a.domain, len(items), sum(d['pin'] for d in items), a.out))


def user_text(o):
    c = o.get('message', {}).get('content')
    if isinstance(c, list):
        c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return c if isinstance(c, str) else ''


def cmd_prompts(a):
    seen, rows = set(), []
    for f in sorted(glob.glob(os.path.join(a.projects_dir, '*.jsonl'))):
        sid = os.path.basename(f)[:8]
        for line in open(f, encoding='utf-8', errors='replace'):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get('type') != 'user' or o.get('isSidechain') or o.get('isMeta'):
                continue
            t = user_text(o).strip()
            ts = (o.get('timestamp') or '')[:10]
            if not t or t.startswith('<') or t.startswith('[Request') or t.startswith('This session is being continued'):
                continue
            if 'tool_use_id' in t or not (a.min_len <= len(t) <= a.max_len):
                continue
            if a.after and ts < a.after:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            rows.append({'session': sid, 'date': ts, 'prompt': t})
    with open(a.out, 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print('%d prompts -> %s' % (len(rows), a.out))


def words(s):
    return [w for w in re.findall(r"[a-z0-9_]+", s.lower()) if w not in STOP and len(w) > 1]


def trigger_hits(prompt, decs):
    p = ' ' + ' '.join(re.findall(r"[a-z0-9_]+", prompt.lower())) + ' '
    hit = set()
    for d in decs:
        for t in d['triggers']:
            tw = ' '.join(re.findall(r"[a-z0-9_]+", t.lower()))
            if tw and (' ' + tw + ' ') in p:
                hit.add(d['id'])
                break
    return hit


def build_fts(decs):
    db = sqlite3.connect(':memory:')
    db.execute("create virtual table f using fts5(id unindexed, body)")
    for d in decs:
        db.execute("insert into f values (?,?)", (d['id'], d['text'] + ' ' + ' '.join(d['triggers'])))
    return db


def fts_hits(db, prompt, k):
    ws = sorted(set(words(prompt)))
    if not ws:
        return set()
    q = ' OR '.join('"%s"' % w for w in ws)
    try:
        rows = db.execute("select id from f where f match ? order by bm25(f) limit ?", (q, k)).fetchall()
    except sqlite3.OperationalError:
        return set()
    return {r[0] for r in rows}


def fts_variant(decs, prompt, tok, k, m):
    """Search variant. tok: porter | tri (substring match on word stems, tolerates endings and some typos);
    k: hits kept; m: minimum distinct prompt words found in an entry's text."""
    ws = sorted(set(words(prompt)))
    if tok == 'tri':
        ws = [w[:max(4, len(w) - 2)] for w in ws if len(w) >= 3]
    if not ws:
        return set()
    db = sqlite3.connect(':memory:')
    db.execute("create virtual table f using fts5(id unindexed, body, tokenize='%s')" % ('porter' if tok == 'porter' else 'trigram'))
    body = {}
    for d in decs:
        body[d['id']] = (d['text'] + ' ' + ' '.join(d['triggers'])).lower()
        db.execute("insert into f values (?,?)", (d['id'], body[d['id']]))
    q = ' OR '.join('"%s"' % w for w in ws)
    try:
        rows = db.execute("select id from f where f match ? order by bm25(f) limit ?", (q, k * 3)).fetchall()
    except sqlite3.OperationalError:
        return set()
    out = []
    for (i,) in rows:
        if sum(1 for w in ws if w in body[i]) >= m:
            out.append(i)
    return set(out[:k])


def run_strategy(name, prompt, decs, pins, db, k):
    if name.startswith('fts:'):
        _, tok, kk, mm = name.split(':')
        return set(pins) | fts_variant(decs, prompt, tok, int(kk[1:]), int(mm[1:]))
    if name == 'pins':
        return set(pins)
    if name == 'triggers':
        return set(pins) | trigger_hits(prompt, decs)
    if name == 'fts':
        return set(pins) | fts_hits(db, prompt, k)
    if name == 'both':
        return set(pins) | trigger_hits(prompt, decs) | fts_hits(db, prompt, k)
    if name == 'all':
        return {d['id'] for d in decs}
    raise ValueError(name)


def cmd_score(a):
    decs_by_domain = json.load(open(a.decisions, encoding='utf-8'))
    gold = []
    for gp in a.gold:
        qs = {q['id']: q for q in json.load(open(gp.replace('gold_', 'questions_'), encoding='utf-8'))}
        for g in json.load(open(gp, encoding='utf-8')):
            ids = list(g['sure']) + (list(g.get('maybe', [])) if a.lenient else [])
            gold.append({'id': g['id'], 'prompt': qs[g['id']]['prompt'], 'domain': qs[g['id']]['domain'], 'gold': ids})
    strategies = ['pins', 'triggers', 'fts', 'both', 'all'] + a.variants
    fetched = {}
    for fp in a.fetch or []:
        fetched.update(json.load(open(fp, encoding='utf-8')))
    if fetched:
        strategies.append('model')
    res = {s: {'hit': 0, 'gold': 0, 'gold_nonpin': 0, 'hit_nonpin': 0, 'extra': 0, 'n': 0, 'noise_n': 0, 'noise_extra': 0, 'misses': []} for s in strategies}
    for q in gold:
        decs = decs_by_domain[q['domain']]
        # the loader reads the area file in full and only the pinned entries of the domain's own file
        pins = [d['id'] for d in decs if d['pin'] or d['source'] != q['domain']]
        pinset = set(pins)
        db = build_fts(decs)
        g = set(q['gold'])
        for s in strategies:
            if s == 'model':
                inj = set(pins) | set(fetched.get(q['id'], []))
            else:
                inj = run_strategy(s, q['prompt'], decs, pins, db, a.top_k)
            extra = len(inj - pinset)
            r = res[s]
            if g:
                r['n'] += 1
                r['gold'] += len(g)
                r['hit'] += len(g & inj)
                gn = g - pinset
                r['gold_nonpin'] += len(gn)
                r['hit_nonpin'] += len(gn & inj)
                r['extra'] += extra
                for m in sorted(g - inj):
                    r['misses'].append((q['id'], m))
            else:
                r['noise_n'] += 1
                r['noise_extra'] += extra
    print('%-18s %8s %10s %10s %10s' % ('strategy', 'recall', 'recall*', 'extra/q', 'noise/q'))
    print('(recall* = share of gold decisions that are NOT pinned and were still surfaced)')
    summary = {}
    for s in strategies:
        r = res[s]
        recall = r['hit'] / r['gold'] if r['gold'] else 0
        rstar = r['hit_nonpin'] / r['gold_nonpin'] if r['gold_nonpin'] else 0
        extra = r['extra'] / r['n'] if r['n'] else 0
        noise = r['noise_extra'] / r['noise_n'] if r['noise_n'] else 0
        print('%-18s %7.0f%% %9.0f%% %10.1f %10.1f' % (s, recall * 100, rstar * 100, extra, noise))
        summary[s] = {'recall': recall, 'recall_nonpin': rstar, 'extra_per_q': extra, 'noise_per_q': noise, 'misses': r['misses']}
    print('questions with gold: %d, empty-gold (noise): %d' % (res['pins']['n'], res['pins']['noise_n']))
    if a.out:
        json.dump(summary, open(a.out, 'w', encoding='utf-8'), indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('decisions')
    p.add_argument('--data-dir', required=True)
    p.add_argument('--domain', required=True)
    p.add_argument('--area')
    p.add_argument('--out', required=True)
    p.set_defaults(fn=cmd_decisions)
    p = sub.add_parser('prompts')
    p.add_argument('--projects-dir', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--min-len', type=int, default=30)
    p.add_argument('--max-len', type=int, default=700)
    p.add_argument('--after')
    p.set_defaults(fn=cmd_prompts)
    p = sub.add_parser('score')
    p.add_argument('--decisions', required=True, help='JSON: {domain: [decisions]}')
    p.add_argument('--gold', required=True, nargs='+', help='gold_<domain>.json files; questions_<domain>.json must sit beside them')
    p.add_argument('--lenient', action='store_true', help='count "maybe" decisions as gold too')
    p.add_argument('--out')
    p.add_argument('--top-k', type=int, default=5)
    p.add_argument('--fetch', nargs='*', help='fetch_<domain>.json files: ids a model chose to fetch per question (scored as strategy "model")')
    p.add_argument('--variants', nargs='*', default=[], help='extra search variants, e.g. fts:porter:k3:m2 fts:tri:k3:m2')
    p.set_defaults(fn=cmd_score)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    sys.exit(main())
