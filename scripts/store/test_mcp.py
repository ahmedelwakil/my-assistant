import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_store import DOMAIN, HISTORY  # noqa: E402


class Client:
    def __init__(self, data_dir):
        self.p = subprocess.Popen([sys.executable, '-X', 'utf8', os.path.join(HERE, 'mcp_server.py'), '--data-dir', data_dir],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.n = 0

    def send(self, method, params=None, notify=False):
        msg = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        if not notify:
            self.n += 1
            msg['id'] = self.n
        self.p.stdin.write(json.dumps(msg) + '\n')
        self.p.stdin.flush()
        return None if notify else json.loads(self.p.stdout.readline())

    def call(self, name, **args):
        r = self.send('tools/call', {'name': name, 'arguments': args})['result']
        return r['isError'], r['content'][0]['text']

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)
        self.p.stdout.close()
        self.p.stderr.close()


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for d in ('domains', 'history', 'state'):
            os.makedirs(self.tmp + '/' + d)
        with open(self.tmp + '/domains/x.md', 'w', encoding='utf-8', newline='') as fh:
            fh.write(DOMAIN)
        with open(self.tmp + '/history/x.md', 'w', encoding='utf-8', newline='') as fh:
            fh.write(HISTORY)
        os.environ['MA_LOCK_TIMEOUT'] = '2'
        self.c = Client(self.tmp)

    def tearDown(self):
        self.c.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def dom(self):
        with open(self.tmp + '/domains/x.md', encoding='utf-8', newline='') as fh:
            return fh.read()

    def test_handshake_and_tool_list(self):
        r = self.c.send('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 't', 'version': '1'}})
        self.assertEqual(r['result']['serverInfo']['name'], 'my-assistant-store')
        self.assertIsNone(self.c.send('notifications/initialized', notify=True))
        names = {t['name'] for t in self.c.send('tools/list')['result']['tools']}
        self.assertTrue({'add_decision', 'add_item', 'update_item', 'complete_item', 'supersede_decision', 'add_history_block',
                         'set_status', 'list_open', 'next_id', 'validate', 'search', 'get_decision'} <= names)
        self.assertEqual(self.c.send('ping')['result'], {})

    def test_add_item_through_the_protocol_changes_the_file(self):
        err, text = self.c.call('add_item', domain='x', text='Chase the vendor', as_of='2026-11-19')
        self.assertFalse(err)
        self.assertIn('- [ ] Chase the vendor (as of 2026-11-19)', self.dom())

    def test_refusal_is_a_tool_error_not_a_crash(self):
        before = self.dom()
        err, text = self.c.call('add_decision', domain='x', text='no triggers', triggers=[], why='w', src='s')
        self.assertTrue(err)
        self.assertIn('refused', text)
        self.assertEqual(self.dom(), before)
        err, _ = self.c.call('next_id', domain='x')  # the server is still alive
        self.assertFalse(err)

    def test_bad_arguments_and_unknown_tool(self):
        self.assertTrue(self.c.call('add_item', domain='x')[0])
        self.assertTrue(self.c.call('add_item', domain='x', text='t', bogus=1)[0])
        self.assertTrue(self.c.call('nope')[0])
        self.assertTrue(self.c.call('list_open', domain='does-not-exist')[0])

    def test_garbage_line_is_ignored_and_unknown_method_errors(self):
        self.c.p.stdin.write('this is not json\n')
        self.c.p.stdin.flush()
        r = self.c.send('does/not/exist')
        self.assertEqual(r['error']['code'], -32601)

    def test_get_decision_and_search_and_validate(self):
        err, text = self.c.call('get_decision', domain='x', id='D-002')
        self.assertFalse(err)
        self.assertIn('detail: more words here.', text)
        err, text = self.c.call('search', domain='x', prompt='tell me about gamma')
        self.assertEqual(json.loads(text), {'ids': ['D-002']})
        err, text = self.c.call('validate', domain='x')
        self.assertEqual(json.loads(text), {'problems': []})


if __name__ == '__main__':
    unittest.main(verbosity=2)
