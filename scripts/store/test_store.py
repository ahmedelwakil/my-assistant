import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store, Refused  # noqa: E402

DOMAIN = """---
domain: x
status: old status
as-of: 2026-01-01
---
# x
## 1. Context
ctx
## 2. Status
old status
## 3. Live decisions
- D-001 [pin] First rule.
  triggers: alpha, beta | decided: 2026-01-01
  why: w | src: user
- D-002 Second rule.
  detail: more words here.
  triggers: gamma | decided: 2026-01-02
  why: w | src: user

## 4. Open items
- [ ] First item (as of 2026-01-05)
- [ ] Second item (as of 2026-02-01)
  - 2026-02-10: a dated update
- [x] Done item (2026-01-03)

## 5. Conventions and gotchas
c
## 6. Pointers and history
p
"""
HISTORY = """### Session: 2026-01-01 00:00 — first
**Done:** x
---

## Superseded decisions
- D-003 Old rule mentions D-099 inside text.
  triggers: old | decided: 2025-01-01
  why: w | src: user
  superseded by D-001 (2026-01-01)
"""


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for d in ('domains', 'history', 'state'):
            os.makedirs(self.tmp + '/' + d)
        self.put('/domains/x.md', DOMAIN)
        self.put('/history/x.md', HISTORY)
        self.st = Store(self.tmp, now=lambda: '2026-11-19')
        os.environ['MA_LOCK_TIMEOUT'] = '1'

    def put(self, rel, text):
        with open(self.tmp + rel, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def dom(self):
        with open(self.tmp + '/domains/x.md', encoding='utf-8', newline='') as fh:
            return fh.read()

    def hist(self):
        with open(self.tmp + '/history/x.md', encoding='utf-8', newline='') as fh:
            return fh.read()

    def only_added(self, before, after, added):
        b, a = before.split('\n'), after.split('\n')
        self.assertEqual(len(a), len(b) + len(added))
        i = next(i for i in range(len(a)) if a[i:i + len(added)] == added)
        self.assertEqual(a[:i] + a[i + len(added):], b)

    def test_next_id_counts_history_and_ignores_stray(self):
        self.assertEqual(self.st.next_id('x'), 'D-004')

    def test_add_decision_inserts_only_its_block(self):
        before = self.dom()
        r = self.st.add_decision('x', 'New rule.', ['t1', 't2'], 'because', 'user 2026-11-19', pin=True, detail='extra')
        self.assertEqual(r['id'], 'D-004')
        added = ['- D-004 [pin] New rule.', '  detail: extra', '  triggers: t1, t2 | decided: 2026-11-19',
                 '  why: because | src: user 2026-11-19']
        self.only_added(before, self.dom(), added)
        self.assertEqual(self.st.validate('x')['problems'], [])

    def test_add_gotcha_allocates_g_ids_and_validates(self):
        before = self.dom()
        r = self.st.add_gotcha('x', 'Worktree setup that works', 'Create it from origin/main; copy .env.', ['worktree', '.env'])
        self.assertEqual(r['id'], 'G-001')
        added = ['- G-001 Worktree setup that works', '  triggers: worktree, .env | noted: 2026-11-19',
                 '  detail: Create it from origin/main; copy .env.']
        self.only_added(before, self.dom(), added)
        self.assertEqual(self.st.add_gotcha('x', 'Second', 'More.', ['t'])['id'], 'G-002')
        self.assertEqual(self.st.validate('x')['problems'], [])
        self.assertIn('G-001', self.st.get_decision('x', 'G-001')['entry'])
        for kw in (dict(title='', detail='d', triggers=['t']), dict(title='t' * 250, detail='d', triggers=['t']),
                   dict(title='t', detail='', triggers=['t']), dict(title='t', detail='d', triggers=[])):
            with self.assertRaises(Refused):
                self.st.add_gotcha('x', **kw)

    def test_fix_decision_changes_only_metadata(self):
        before = self.dom()
        self.st.fix_decision('x', 'D-002', triggers=['gamma', 'delta'], src='history/x.md (T-1)')
        after = self.dom()
        b, a = before.split('\n'), after.split('\n')
        changed = [(x, y) for x, y in zip(b, a) if x != y]
        self.assertEqual(len(b), len(a))
        self.assertEqual(len(changed), 2)
        self.assertIn('  triggers: gamma, delta | decided: 2026-01-02', after)
        self.assertIn('  why: w | src: history/x.md (T-1)', after)
        self.assertIn('- D-002 Second rule.\n  detail: more words here.', after)
        with self.assertRaises(Refused):
            self.st.fix_decision('x', 'D-002')
        with self.assertRaises(Refused):
            self.st.fix_decision('x', 'D-002', triggers=[])
        with self.assertRaises(Refused):
            self.st.fix_decision('x', 'D-999', src='s')

    def test_fix_decision_adds_missing_src_and_missing_triggers(self):
        text = self.dom().replace('  triggers: gamma | decided: 2026-01-02\n  why: w | src: user', '  why: w')
        self.put('/domains/x.md', text)
        self.assertTrue(self.st.validate('x')['problems'])
        self.st.fix_decision('x', 'D-002', triggers=['gamma'], src='user 2026')
        self.assertEqual(self.st.validate('x')['problems'], [])

    def test_refusals_leave_file_unchanged(self):
        before = self.dom()
        bad = [dict(text='', triggers=['a'], why='w', src='s'), dict(text='x' * 400, triggers=['a'], why='w', src='s'),
               dict(text='ok', triggers=[], why='w', src='s'), dict(text='ok', triggers=['a'], why='', src='s'),
               dict(text='ok', triggers=['a'], why='w', src=''), dict(text='a\nb', triggers=['a'], why='w', src='s'),
               dict(text='ok', triggers=['a'], why='w', src='s', decided='19/11/2026')]
        for kw in bad:
            with self.assertRaises(Refused):
                self.st.add_decision('x', **kw)
        self.assertEqual(self.dom(), before)

    def test_add_item_and_dates(self):
        before = self.dom()
        self.st.add_item('x', 'Chase the vendor', due='2026-11-26', check='PR #5')
        added = ['- [ ] Chase the vendor (as of 2026-11-19) (due 2026-11-26) (check: PR #5)']
        self.only_added(before, self.dom(), added)
        with self.assertRaises(Refused):
            self.st.add_item('x', 'bad date', as_of='yesterday')
        with self.assertRaises(Refused):
            self.st.add_item('x', 'y' * 400)

    def test_update_item(self):
        self.st.update_item('x', 'First item', 'checked live, still open', verified=True)
        self.assertIn('- [ ] First item (as of 2026-11-19)\n  - 2026-11-19: checked live, still open', self.dom())
        with self.assertRaises(Refused):
            self.st.update_item('x', 'item', 'ambiguous match')
        with self.assertRaises(Refused):
            self.st.update_item('x', 'Done item', 'closed already')
        self.st.update_item('x', 'Second item', 'unverified note')
        self.assertIn('(as of 2026-02-01)', self.dom())

    def test_complete_item(self):
        self.st.complete_item('x', 'First item')
        self.assertIn('- [x] First item (as of 2026-01-05) (2026-11-19)', self.dom())
        self.st.complete_item('x', 'Second item', dropped='no longer needed')
        self.assertIn('dropped: no longer needed (2026-11-19)', self.dom())
        with self.assertRaises(Refused):
            self.st.complete_item('x', 'First item')

    def test_list_open_oldest_first_uses_latest_date_in_item(self):
        self.assertEqual([x['latest'] for x in self.st.list_open('x')], ['2026-01-05', '2026-02-10'])

    def test_supersede_moves_block_and_keeps_ids_monotonic(self):
        self.st.add_decision('x', 'Replacement.', ['a'], 'w', 's')
        self.st.supersede_decision('x', 'D-002', 'D-004')
        self.assertNotIn('- D-002 Second rule.', self.dom())
        h = self.hist()
        self.assertIn('- D-002 Second rule.\n  detail: more words here.', h)
        self.assertIn('superseded by D-004 (2026-11-19)', h)
        self.assertEqual(self.st.next_id('x'), 'D-005')
        with self.assertRaises(Refused):
            self.st.supersede_decision('x', 'D-999', 'D-004')
        with self.assertRaises(Refused):
            self.st.supersede_decision('x', 'D-001', 'D-777')

    def test_history_block_goes_before_superseded_heading(self):
        self.st.add_history_block('x', 'second session', '**Done:** y', stamp='2026-11-19 10:00')
        h = self.hist()
        self.assertLess(h.index('second session'), h.index('## Superseded decisions'))
        self.assertLess(h.index('first'), h.index('second session'))

    def test_set_status(self):
        self.st.set_status('x', 'new short status')
        d = self.dom()
        self.assertIn('status: new short status', d)
        self.assertIn('as-of: 2026-11-19', d)
        self.assertIn('## 2. Status\nnew short status\n## 3.', d)
        with self.assertRaises(Refused):
            self.st.set_status('x', 's' * 200)

    def test_crlf_preserved(self):
        p = self.tmp + '/domains/x.md'
        open(p, 'w', encoding='utf-8', newline='').write(DOMAIN.replace('\n', '\r\n'))
        self.st.add_item('x', 'crlf item')
        raw = open(p, 'rb').read()
        self.assertNotIn(b'\n', raw.replace(b'\r\n', b''))

    def test_read_write_roundtrip_is_byte_identical(self):
        for p in (self.tmp + '/domains/x.md', self.tmp + '/history/x.md'):
            raw = open(p, 'rb').read()
            lines, nl = Store.read(p)
            Store.write(p, lines, nl)
            self.assertEqual(open(p, 'rb').read(), raw)

    def test_backup_made(self):
        self.st.add_item('x', 'backup me')
        self.assertTrue(any(f.startswith('x.md.') for f in os.listdir(self.tmp + '/state/backups')))

    def test_stale_lock_is_broken_and_fresh_lock_blocks(self):
        lock = self.tmp + '/state/.write.lock'
        open(lock, 'w').write('x')
        old = time.time() - 1200
        os.utime(lock, (old, old))
        self.st.add_item('x', 'after stale lock')
        open(lock, 'w').write('held')
        with self.assertRaises(Refused):
            self.st.add_item('x', 'blocked')
        os.remove(lock)

    def test_concurrent_writers_get_unique_ids(self):
        here = os.path.dirname(os.path.abspath(__file__)).replace('\\', '/')
        code = ("import sys; sys.path.insert(0, '%s'); from store import Store; s = Store('%s')\n"
                "for i in range(5): s.add_decision('x', 'rule %%s' %% i, ['t'], 'w', 's')\n") % (here, self.tmp.replace('\\', '/'))
        env = dict(os.environ, MA_LOCK_TIMEOUT='60')
        ps = [subprocess.Popen([sys.executable, '-X', 'utf8', '-c', code], env=env) for _ in range(4)]
        for p in ps:
            self.assertEqual(p.wait(), 0)
        ids = [l.split()[1] for l in self.dom().split('\n') if l.startswith('- D-')]
        self.assertEqual(len(ids), 22)
        self.assertEqual(len(set(ids)), 22)
        self.assertEqual(self.st.validate('x')['problems'], [])


class IndexTests(unittest.TestCase):
    setUp, tearDown, put, dom, hist = T.setUp, T.tearDown, T.put, T.dom, T.hist

    """The derived search index must follow the markdown: new entries appear, superseded ones vanish,
    and deleting the file loses nothing."""

    def build(self):
        from store import build_index
        self.idx = self.tmp + '/state/index.sqlite'
        return build_index(self.tmp, self.idx)

    def find(self, prompt):
        from store import search_index
        return search_index(self.idx, 'x', prompt, 5)

    def test_index_covers_live_entries_and_skips_pins(self):
        self.assertEqual(self.build(), 2)
        self.assertEqual(self.find('what about gamma'), ['D-002'])
        self.assertEqual(self.find('alpha beta'), [])  # D-001 is pinned, already loaded

    def test_new_entry_found_after_rebuild_and_not_before(self):
        self.build()
        self.st.add_decision('x', 'Quarantine flaky jobs.', ['quarantine'], 'w', 's')
        self.assertEqual(self.find('quarantine the flaky job'), [])
        self.build()
        self.assertEqual(self.find('quarantine the flaky job'), ['D-004'])

    def test_superseded_entry_disappears_after_rebuild(self):
        self.st.add_decision('x', 'Replacement rule about gamma ray.', ['gamma'], 'w', 's')
        self.st.supersede_decision('x', 'D-002', 'D-004')
        self.build()
        self.assertNotIn('D-002', self.find('gamma'))
        self.assertIn('D-004', self.find('gamma'))

    def test_gotchas_are_indexed(self):
        self.st.add_gotcha('x', 'Quarantine recipe for flaky jobs', 'Move the job to the slow queue.', ['quarantine'])
        self.build()
        self.assertEqual(self.find('how do I quarantine the flaky job'), ['G-001'])

    def test_deleting_the_index_loses_nothing(self):
        self.build()
        first = self.find('gamma')
        os.remove(self.idx)
        self.build()
        self.assertEqual(self.find('gamma'), first)


if __name__ == '__main__':
    unittest.main(verbosity=2)
