#!/usr/bin/env python3
"""Typed save operations for the knowledge store (markdown stays the source of truth).

Every write: takes state/.write.lock (exclusive create, stale after 10 minutes), re-reads the target files
inside the lock, validates the entry, backs the file up to state/backups/, edits only the targeted lines and
replaces the file atomically. Standard library only.

CLI:  python store.py --data-dir DIR OP '{"json": "arguments"}'   (prints a JSON result, exit 1 on refusal)
Ops:  add_decision add_item update_item complete_item supersede_decision add_history_block
      set_status list_open next_id validate
"""
import argparse
import datetime
import json
import os
import re
import sys
import time

ISO = re.compile(r'\d{4}-\d{2}-\d{2}')
ENTRY = re.compile(r'^- ((?:D|A|G)-\d+)\b')
ITEM = re.compile(r'^- \[([ x])\] (.*)$')
RULE_MAX = 320
TITLE_MAX = 320
STATUS_MAX = 130


class Refused(Exception):
    pass


def today():
    return datetime.date.today().isoformat()


class Store:
    def __init__(self, data_dir, now=None):
        self.dir = data_dir.replace('\\', '/').rstrip('/')
        self.now = now or today

    # ---------- paths and io ----------
    def dom(self, name):
        return '%s/domains/%s.md' % (self.dir, name)

    def hist(self, name):
        return '%s/history/%s.md' % (self.dir, name)

    @staticmethod
    def read(path):
        with open(path, encoding='utf-8', newline='') as fh:
            raw = fh.read()
        nl = '\r\n' if '\r\n' in raw else '\n'
        return raw.replace('\r\n', '\n').split('\n'), nl

    @staticmethod
    def write(path, lines, nl):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as fh:
            fh.write(nl.join(lines))
        os.replace(tmp, path)

    def backup(self, path):
        bdir = '%s/state/backups' % self.dir
        os.makedirs(bdir, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        name = os.path.basename(path)
        dst = '%s/%s.%s.bak' % (bdir, name, stamp)
        n = 0
        while os.path.exists(dst):
            n += 1
            dst = '%s/%s.%s-%d.bak' % (bdir, name, stamp, n)
        with open(path, 'rb') as src, open(dst, 'wb') as out:
            out.write(src.read())
        olds = sorted(f for f in os.listdir(bdir) if f.startswith(name + '.'))
        for f in olds[:-20]:
            os.remove('%s/%s' % (bdir, f))

    class Lock:
        def __init__(self, st):
            self.path = '%s/state/.write.lock' % st.dir
            os.makedirs(os.path.dirname(self.path), exist_ok=True)

        def __enter__(self):
            deadline = time.time() + float(os.environ.get('MA_LOCK_TIMEOUT', '30'))
            while True:
                try:
                    fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.write(fd, datetime.datetime.utcnow().isoformat().encode())
                    os.close(fd)
                    return self
                except FileExistsError:
                    try:
                        if time.time() - os.path.getmtime(self.path) > 600:
                            os.remove(self.path)
                            continue
                    except OSError:
                        pass
                    if time.time() > deadline:
                        raise Refused('write lock is held by another writer')
                    time.sleep(0.05)

        def __exit__(self, *a):
            try:
                os.remove(self.path)
            except OSError:
                pass

    # ---------- parsing ----------
    @staticmethod
    def section(lines, num):
        """(start, end) line indexes of section `## num.` body (heading excluded)."""
        start = None
        for i, l in enumerate(lines):
            if l.startswith('## %d.' % num):
                start = i + 1
            elif start is not None and l.startswith('## '):
                return start, i
        if start is None:
            raise Refused('section %d heading missing' % num)
        return start, len(lines)

    @staticmethod
    def blocks(lines, start, end, head):
        """Entry blocks inside [start, end): each begins at a head-matching line and runs over indented lines."""
        out, i = [], start
        while i < end:
            if head.match(lines[i]):
                j = i + 1
                while j < end and lines[j].startswith('  '):
                    j += 1
                out.append((i, j))
                i = j
            else:
                i += 1
        return out

    @staticmethod
    def last_nonblank(lines, start, end):
        k = end
        while k > start and lines[k - 1].strip() == '':
            k -= 1
        return k

    def next_id(self, domain, prefix='D'):
        ids = [0]
        lines, _ = self.read(self.dom(domain))
        for l in lines:
            m = re.match(r'^- %s-(\d+)\b' % prefix, l)
            if m:
                ids.append(int(m.group(1)))
        hp = self.hist(domain)
        if os.path.exists(hp):
            hl, _ = self.read(hp)
            on = False
            for l in hl:
                if l.startswith('## '):
                    on = l.startswith('## Superseded decisions') or l.startswith('## Retired decisions')
                    continue
                if on:
                    m = re.match(r'^- %s-(\d+)\b' % prefix, l)
                    if m:
                        ids.append(int(m.group(1)))
        return '%s-%03d' % (prefix, max(ids) + 1)

    # ---------- validation ----------
    @staticmethod
    def check_date(d, what):
        if not ISO.fullmatch(d or ''):
            raise Refused('%s must be an ISO date YYYY-MM-DD, got %r' % (what, d))

    # ---------- operations ----------
    def add_decision(self, domain, text, triggers, why, src, pin=False, detail=None, decided=None):
        text = (text or '').strip()
        if not text or '\n' in text:
            raise Refused('rule text is required and must be one line')
        if len(text) > RULE_MAX:
            raise Refused('rule is %d chars, keep it to %d and put the rest in detail' % (len(text), RULE_MAX))
        if not triggers or not all(isinstance(t, str) and t.strip() for t in triggers):
            raise Refused('at least one trigger word is required')
        if not (why or '').strip() or not (src or '').strip():
            raise Refused('why and src are both required')
        decided = decided or self.now()
        self.check_date(decided, 'decided')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            new_id = self.next_id(domain)
            s, e = self.section(lines, 3)
            at = self.last_nonblank(lines, s, e)
            block = ['- %s%s %s' % (new_id, ' [pin]' if pin else '', text)]
            if detail:
                block.append('  detail: ' + detail.strip())
            block.append('  triggers: %s | decided: %s' % (', '.join(t.strip() for t in triggers), decided))
            block.append('  why: %s | src: %s' % (why.strip(), src.strip()))
            self.backup(path)
            lines[at:at] = block
            self.write(path, lines, nl)
        return {'id': new_id}

    def _find_item(self, lines, match):
        s, e = self.section(lines, 4)
        hits = [(a, b) for a, b in self.blocks(lines, s, e, ITEM) if match in lines[a]]
        if len(hits) != 1:
            raise Refused('match %r found %d items, need exactly 1' % (match, len(hits)))
        return hits[0]

    def add_item(self, domain, text, as_of=None, due=None, check=None):
        text = (text or '').strip()
        if not text or '\n' in text:
            raise Refused('item text is required and must be one line')
        as_of = as_of or self.now()
        self.check_date(as_of, 'as_of')
        tail = ' (as of %s)' % as_of
        if due:
            self.check_date(due, 'due')
            tail += ' (due %s)' % due
        if check:
            tail += ' (check: %s)' % check
        if len(text) + len(tail) > TITLE_MAX:
            raise Refused('item title is %d chars with its date tags, keep it to %d and add a dated update line instead' % (len(text) + len(tail), TITLE_MAX))
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            s, e = self.section(lines, 4)
            at = self.last_nonblank(lines, s, e)
            self.backup(path)
            lines[at:at] = ['- [ ] %s%s' % (text, tail)]
            self.write(path, lines, nl)
        return {'ok': True}

    def update_item(self, domain, match, update, date=None, verified=False):
        update = (update or '').strip()
        if not update or '\n' in update:
            raise Refused('update must be one non-empty line')
        date = date or self.now()
        self.check_date(date, 'date')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            a, b = self._find_item(lines, match)
            if lines[a].startswith('- [x]'):
                raise Refused('item is already closed')
            if verified:
                lines[a] = re.sub(r'\(as of \d{4}-\d{2}-\d{2}\)', '(as of %s)' % date, lines[a], count=1)
            lines.insert(b, '  - %s: %s' % (date, update))
            self.backup(path)
            self.write(path, lines, nl)
        return {'ok': True}

    def complete_item(self, domain, match, date=None, dropped=None):
        date = date or self.now()
        self.check_date(date, 'date')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            a, b = self._find_item(lines, match)
            if lines[a].startswith('- [x]'):
                raise Refused('item is already closed')
            lines[a] = '- [x] ' + lines[a][len('- [ ] '):] + (' dropped: %s (%s)' % (dropped, date) if dropped else ' (%s)' % date)
            self.backup(path)
            self.write(path, lines, nl)
        return {'ok': True}

    def supersede_decision(self, domain, old_id, by_id, date=None):
        date = date or self.now()
        self.check_date(date, 'date')
        with self.Lock(self):
            path, hp = self.dom(domain), self.hist(domain)
            lines, nl = self.read(path)
            s, e = self.section(lines, 3)
            hits = [(a, b) for a, b in self.blocks(lines, s, e, ENTRY) if re.match(r'^- %s\b' % re.escape(old_id), lines[a])]
            if len(hits) != 1:
                raise Refused('decision %s not found as a live entry' % old_id)
            if not any(re.match(r'^- %s\b' % re.escape(by_id), l) for l in lines):
                raise Refused('superseding decision %s does not exist' % by_id)
            a, b = hits[0]
            moved = lines[a:b] + ['  superseded by %s (%s)' % (by_id, date)]
            hl, hnl = self.read(hp) if os.path.exists(hp) else ([''], '\n')
            heads = [i for i, l in enumerate(hl) if l.startswith('## Superseded decisions')]
            self.backup(path)
            if os.path.exists(hp):
                self.backup(hp)
            if heads:
                nxt = next((i for i in range(heads[0] + 1, len(hl)) if hl[i].startswith('## ')), len(hl))
                at = self.last_nonblank(hl, heads[0] + 1, nxt)
                hl[at:at] = moved
            else:
                hl += ['', '## Superseded decisions'] + moved
            self.write(hp, hl, hnl)
            del lines[a:b]
            self.write(path, lines, nl)
        return {'ok': True}

    def add_history_block(self, domain, topic, body, stamp=None):
        stamp = stamp or time.strftime('%Y-%m-%d %H:%M')
        if not (topic or '').strip() or not (body or '').strip():
            raise Refused('topic and body are required')
        with self.Lock(self):
            hp = self.hist(domain)
            hl, hnl = self.read(hp) if os.path.exists(hp) else ([''], '\n')
            heads = [i for i, l in enumerate(hl) if l.startswith('## Superseded decisions') or l.startswith('## Retired decisions')]
            at = heads[0] if heads else len(hl)
            block = ['### Session: %s — %s' % (stamp, topic.strip())] + body.strip().split('\n') + ['---', '']
            if os.path.exists(hp):
                self.backup(hp)
            hl[at:at] = block
            self.write(hp, hl, hnl)
        return {'ok': True}

    def set_status(self, domain, status, as_of=None):
        status = (status or '').strip()
        if not status or '\n' in status or len(status) > STATUS_MAX:
            raise Refused('status must be one line of at most %d characters' % STATUS_MAX)
        as_of = as_of or self.now()
        self.check_date(as_of, 'as_of')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            n = 0
            for i, l in enumerate(lines[:20]):
                if l.startswith('status:'):
                    lines[i] = 'status: ' + status
                    n += 1
                elif l.startswith('as-of:'):
                    lines[i] = 'as-of: ' + as_of
                    n += 1
            if n != 2:
                raise Refused('frontmatter status/as-of lines not found')
            s, e = self.section(lines, 2)
            body = [i for i in range(s, e) if lines[i].strip()]
            if body:
                lines[body[0]:body[-1] + 1] = [status]
            else:
                lines[s:s] = [status]
            self.backup(path)
            self.write(path, lines, nl)
        return {'ok': True}

    def fix_decision(self, domain, id, triggers=None, src=None):
        """Repair the metadata of a live decision without touching its rule text: replace its trigger words
        (keeping its `| decided:` part) and/or set its src (replacing an existing one or appending it)."""
        if triggers is None and src is None:
            raise Refused('give triggers and/or src')
        if triggers is not None and (not triggers or not all(isinstance(t, str) and t.strip() for t in triggers)):
            raise Refused('triggers must be a non-empty list of words')
        if src is not None and not src.strip():
            raise Refused('src must not be empty')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            s, e = self.section(lines, 3)
            hit = [(a, b) for a, b in self.blocks(lines, s, e, ENTRY) if re.match(r'^- %s\b' % re.escape(id), lines[a])]
            if len(hit) != 1:
                raise Refused('decision %s not found as a live entry' % id)
            a, b = hit[0]
            why = next((i for i in range(a, b) if lines[i].startswith('  why:')), None)
            if why is None:
                raise Refused('decision %s has no why line' % id)
            if triggers is not None:
                words = ', '.join(t.strip() for t in triggers)
                tl = next((i for i in range(a, b) if lines[i].startswith('  triggers:')), None)
                if tl is None:
                    lines.insert(why, '  triggers: %s | decided: %s' % (words, self.now()))
                    why += 1
                else:
                    rest = lines[tl].split('|', 1)
                    lines[tl] = '  triggers: %s%s' % (words, (' |' + rest[1]) if len(rest) > 1 else '')
            if src is not None:
                if '| src:' in lines[why]:
                    lines[why] = lines[why].split('| src:')[0] + '| src: ' + src.strip()
                else:
                    lines[why] = lines[why].rstrip() + ' | src: ' + src.strip()
            self.backup(path)
            self.write(path, lines, nl)
        return {'ok': True}

    def get_decision(self, domain, id):
        """Return the full entry block (head, detail, triggers, why) of a live decision or gotcha."""
        lines, _ = self.read(self.dom(domain))
        for n in (3, 5):
            s, e = self.section(lines, n)
            for a, b in self.blocks(lines, s, e, ENTRY):
                if re.match(r'^- %s\b' % re.escape(id), lines[a]):
                    return {'entry': '\n'.join(lines[a:b])}
        raise Refused('entry %s not found as a live decision or gotcha' % id)

    def add_gotcha(self, domain, title, detail, triggers, noted=None):
        """Add a gotcha (a lesson, recipe or fact with no rule in it) to section 5: a short title line,
        the full text on a `detail:` line and trigger words. Allocates the next G- id."""
        title, detail = (title or '').strip(), (detail or '').strip()
        if not title or '\n' in title or len(title) > 200:
            raise Refused('title is required, one line, at most 200 characters')
        if not detail or '\n' in detail:
            raise Refused('detail is required and must be one line')
        if not triggers or not all(isinstance(t, str) and t.strip() for t in triggers):
            raise Refused('at least one trigger word is required')
        noted = noted or self.now()
        self.check_date(noted, 'noted')
        with self.Lock(self):
            path = self.dom(domain)
            lines, nl = self.read(path)
            new_id = self.next_id(domain, 'G')
            s, e = self.section(lines, 5)
            at = self.last_nonblank(lines, s, e)
            block = ['- %s %s' % (new_id, title),
                     '  triggers: %s | noted: %s' % (', '.join(t.strip() for t in triggers), noted),
                     '  detail: ' + detail]
            self.backup(path)
            lines[at:at] = block
            self.write(path, lines, nl)
        return {'id': new_id}

    def search(self, domain, prompt, k=3):
        """Keyword search over the derived index of non-pinned entries (rebuilt each call, a few ms).
        Decisions and gotchas are searched as two separate lists of up to k ids each."""
        idx = '%s/state/index.sqlite' % self.dir
        build_index(self.dir, idx)
        return {'ids': search_index(idx, domain, prompt, k, 'decisions'), 'gotchas': search_index(idx, domain, prompt, k, 'gotchas')}

    def list_open(self, domain, limit=20):
        lines, _ = self.read(self.dom(domain))
        s, e = self.section(lines, 4)
        out = []
        for a, b in self.blocks(lines, s, e, ITEM):
            if lines[a].startswith('- [x]'):
                continue
            dates = ISO.findall('\n'.join(lines[a:b]))
            out.append({'latest': max(dates) if dates else None, 'item': lines[a][:200]})
        out.sort(key=lambda x: x['latest'] or '')
        return out[:limit]

    def validate(self, domain):
        problems = []
        lines, _ = self.read(self.dom(domain))
        for n in range(1, 7):
            try:
                self.section(lines, n)
            except Refused:
                problems.append('section %d missing' % n)
        try:
            s, e = self.section(lines, 3)
            seen = set()
            for a, b in self.blocks(lines, s, e, ENTRY):
                i = ENTRY.match(lines[a]).group(1)
                blk = '\n'.join(lines[a:b])
                if i in seen:
                    problems.append('duplicate id %s' % i)
                seen.add(i)
                if '  triggers:' not in blk or '| src:' not in blk:
                    problems.append('%s lacks triggers or src' % i)
            s, e = self.section(lines, 5)
            for a, b in self.blocks(lines, s, e, ENTRY):
                i = ENTRY.match(lines[a]).group(1)
                if i in seen:
                    problems.append('duplicate id %s' % i)
                seen.add(i)
                if '  triggers:' not in '\n'.join(lines[a:b]):
                    problems.append('%s lacks triggers' % i)
            s, e = self.section(lines, 4)
            for a, b in self.blocks(lines, s, e, ITEM):
                if lines[a].startswith('- [ ]') and not ISO.search('\n'.join(lines[a:b])):
                    problems.append('undated open item: %s' % lines[a][:60])
        except Refused:
            pass
        return {'problems': problems}


STOP = set('the a an and or of to in on for with is are be this that it as at by from not no do does did we you i my your our if then else when how what why which can should would could will just also than so but into out up'.split())


def build_index(data_dir, out_path):
    """Derived keyword index (SQLite FTS5) over every live decision of every domain and area file.
    It is rebuilt from the markdown in full each time and can be deleted at any time: never a source of truth."""
    import sqlite3
    d = data_dir.replace('\\', '/').rstrip('/')
    tmp = out_path + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute("create virtual table f using fts5(file unindexed, id unindexed, pin unindexed, rule, triggers)")
    n = 0
    for path in sorted(os.listdir(d + '/domains')):
        if not path.endswith('.md') or path == 'global.md':
            continue
        lines, _ = Store.read(d + '/domains/' + path)
        try:
            ranges = [(0, len(lines))] if path.endswith('.area.md') else [Store.section(lines, 3), Store.section(lines, 5)]
        except Refused:
            continue
        for s, e in ranges:
            for a, b in Store.blocks(lines, s, e, ENTRY):
                m = re.match(r'^- ((?:D|A|G)-\d+)\s*(\[pin\])?\s*(.*)$', lines[a])
                trig = next((l[len('  triggers:'):].split('|')[0].strip() for l in lines[a:b] if l.startswith('  triggers:')), '')
                detail = ' '.join(l[len('  detail:'):].strip() for l in lines[a:b] if l.startswith('  detail:'))
                db.execute("insert into f values (?,?,?,?,?)", (path[:-3], m.group(1), '1' if m.group(2) else '0', (m.group(3) + ' ' + detail).strip(), trig))
                n += 1
    db.commit()
    db.close()
    os.replace(tmp, out_path)
    return n


def search_index(index_path, file, prompt, k=3, kind=None):
    """Top-k ids for a prompt. kind: None (all), 'decisions' (D- and A- entries) or 'gotchas' (G- entries);
    searching the kinds separately stops one kind from crowding out the other."""
    import sqlite3
    ws = sorted({w for w in re.findall(r'[a-z0-9_]+', prompt.lower()) if w not in STOP and len(w) > 1})
    if not ws:
        return []
    db = sqlite3.connect(index_path)
    try:
        q = ' OR '.join('"%s"' % w for w in ws)
        cond = {'decisions': " and id not like 'G-%'", 'gotchas': " and id like 'G-%'"}.get(kind, '')
        rows = db.execute("select id from f where f match ? and file = ? and pin = '0'" + cond + " order by bm25(f) limit ?", (q, file, k)).fetchall()
    finally:
        db.close()
    return [r[0] for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True)
    ap.add_argument('op')
    ap.add_argument('args', nargs='?', default='{}')
    a = ap.parse_args()
    try:
        res = getattr(Store(a.data_dir), a.op)(**json.loads(a.args))
        print(json.dumps(res, ensure_ascii=False))
        return 0
    except Refused as ex:
        print(json.dumps({'refused': str(ex)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
