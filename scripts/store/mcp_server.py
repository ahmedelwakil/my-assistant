#!/usr/bin/env python3
"""MCP server (stdio, JSON-RPC 2.0, standard library only) exposing the typed save operations of store.py.

Register once (user scope), the data directory is read from the my-assistant config:
  claude mcp add --scope user my-assistant-store -- python -X utf8 /path/to/scripts/store/mcp_server.py
Optional: --data-dir DIR overrides the config (testing, sandboxes).

Every tool validates its input and refuses bad entries; a refusal or any error is returned as a tool error
(isError true) and never crashes the server. Messages are one JSON object per line.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store, Refused  # noqa: E402

PROTOCOL = '2024-11-05'
STR = {'type': 'string'}
DOMAIN = {'type': 'string', 'description': 'domain name, e.g. the file name under domains/ without .md'}


def obj(props, required):
    return {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}


TOOLS = {
    'add_decision': ('Add a live decision (rule, triggers, why, src). Allocates the next free id; refuses a missing trigger, why or src, a rule over 320 chars (put the rest in detail), or a bad date.',
                     obj({'domain': DOMAIN, 'text': STR, 'triggers': {'type': 'array', 'items': STR}, 'why': STR, 'src': STR,
                          'pin': {'type': 'boolean'}, 'detail': STR, 'decided': STR}, ['domain', 'text', 'triggers', 'why', 'src'])),
    'supersede_decision': ('Move a live decision to the history file marked superseded by another existing decision.',
                           obj({'domain': DOMAIN, 'old_id': STR, 'by_id': STR, 'date': STR}, ['domain', 'old_id', 'by_id'])),
    'get_decision': ('Return the full text of one live decision (rule, detail, triggers, why).',
                     obj({'domain': DOMAIN, 'id': STR}, ['domain', 'id'])),
    'add_item': ('Add an open item with an as-of date (title at most 320 chars; add long narrative with update_item).',
                 obj({'domain': DOMAIN, 'text': STR, 'as_of': STR, 'due': STR, 'check': STR}, ['domain', 'text'])),
    'update_item': ('Append a dated update line under one open item (match must identify exactly one item). verified=true also refreshes its as-of date.',
                    obj({'domain': DOMAIN, 'match': STR, 'update': STR, 'date': STR, 'verified': {'type': 'boolean'}}, ['domain', 'match', 'update'])),
    'complete_item': ('Close one open item as done, or as dropped with a reason.',
                      obj({'domain': DOMAIN, 'match': STR, 'date': STR, 'dropped': STR}, ['domain', 'match'])),
    'list_open': ('List open items oldest first by the latest date in each item.',
                  obj({'domain': DOMAIN, 'limit': {'type': 'integer'}}, ['domain'])),
    'set_status': ('Replace the one-line status (frontmatter, status section and as-of together). At most 130 characters.',
                   obj({'domain': DOMAIN, 'status': STR, 'as_of': STR}, ['domain', 'status'])),
    'add_history_block': ('Append a session block to the domain history file, before its superseded/retired section.',
                          obj({'domain': DOMAIN, 'topic': STR, 'body': STR, 'stamp': STR}, ['domain', 'topic', 'body'])),
    'next_id': ('Return the next free decision id by the allocation rule (live entries plus superseded/retired history).',
                obj({'domain': DOMAIN, 'prefix': {'type': 'string', 'enum': ['D', 'A']}}, ['domain'])),
    'validate': ('Check a domain file: sections, unique ids, triggers and src on every decision, dated open items.',
                 obj({'domain': DOMAIN}, ['domain'])),
    'search': ('Keyword search over the non-pinned decisions of a domain; returns ids only. Use it as a check for missed entries, not as a replacement for judging relevance.',
               obj({'domain': DOMAIN, 'prompt': STR, 'k': {'type': 'integer'}}, ['domain', 'prompt'])),
}


def data_dir():
    for i, a in enumerate(sys.argv):
        if a == '--data-dir' and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    pointer = os.path.join(os.path.expanduser('~'), '.claude', 'my-assistant', 'config-location')
    with open(pointer, encoding='utf-8') as fh:
        cfg_path = os.path.expanduser(json.load(fh)['configPath'])
    with open(cfg_path, encoding='utf-8') as fh:
        return os.path.expanduser(json.load(fh)['dataDir'])


def result(id_, payload, error=False):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return {'jsonrpc': '2.0', 'id': id_, 'result': {'content': [{'type': 'text', 'text': text}], 'isError': error}}


def handle(msg, store):
    method, id_, params = msg.get('method'), msg.get('id'), msg.get('params') or {}
    if method == 'initialize':
        return {'jsonrpc': '2.0', 'id': id_, 'result': {'protocolVersion': PROTOCOL, 'capabilities': {'tools': {}},
                                                       'serverInfo': {'name': 'my-assistant-store', 'version': '0.1.0'}}}
    if method == 'ping':
        return {'jsonrpc': '2.0', 'id': id_, 'result': {}}
    if method == 'tools/list':
        return {'jsonrpc': '2.0', 'id': id_, 'result': {'tools': [
            {'name': n, 'description': d, 'inputSchema': schema} for n, (d, schema) in TOOLS.items()]}}
    if method == 'tools/call':
        name, args = params.get('name'), params.get('arguments') or {}
        if name not in TOOLS:
            return result(id_, 'unknown tool %r' % name, True)
        schema = TOOLS[name][1]
        unknown = [k for k in args if k not in schema['properties']]
        missing = [k for k in schema['required'] if k not in args]
        if unknown or missing:
            return result(id_, 'bad arguments: unknown %s, missing %s' % (unknown, missing), True)
        try:
            return result(id_, getattr(store, name)(**args))
        except Refused as ex:
            return result(id_, 'refused: %s' % ex, True)
        except Exception as ex:  # never crash the server on one bad call
            return result(id_, 'error: %s: %s' % (type(ex).__name__, ex), True)
    if id_ is None:
        return None  # a notification, no reply
    return {'jsonrpc': '2.0', 'id': id_, 'error': {'code': -32601, 'message': 'method not found: %s' % method}}


def main():
    store = Store(data_dir())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        reply = handle(msg, store) if isinstance(msg, dict) else None
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + '\n')
            sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
