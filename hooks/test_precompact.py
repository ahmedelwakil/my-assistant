import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "my-assistant-precompact.py")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pre compact ")  # a space on purpose
        self.home = os.path.join(self.tmp, "home")  # no config pointer here: the hook must still behave
        os.makedirs(self.home)
        self.dst = os.path.join(self.tmp, "backup dir")

    def run_hook(self, stdin, extra=()):
        env = dict(os.environ, USERPROFILE=self.home, HOME=self.home)
        t0 = time.time()
        p = subprocess.run([sys.executable, "-X", "utf8", HOOK, "--backup-dir", self.dst] + list(extra),
                           input=stdin, capture_output=True, text=True, env=env, timeout=120)
        return p, time.time() - t0

    def make_transcript(self, size_mb=1):
        path = os.path.join(self.tmp, "t.jsonl")
        with open(path, "wb") as fh:
            fh.write((json.dumps({"type": "user", "message": {"content": "x" * 1000}}) + "\n").encode() * (size_mb * 1000))
        return path

    def test_copies_transcript_and_prints_instructions_exit_zero(self):
        t = self.make_transcript(2)
        p, _ = self.run_hook(json.dumps({"session_id": "abc123", "transcript_path": t, "trigger": "auto"}))
        self.assertEqual(p.returncode, 0)
        self.assertLess(len(p.stdout), 10000)
        self.assertIn("not yet been saved", p.stdout)
        self.assertEqual(sha(os.path.join(self.dst, "abc123.jsonl")), sha(t))
        self.assertFalse([f for f in os.listdir(self.dst) if f.endswith(".tmp")])

    def test_second_compaction_overwrites_not_accumulates(self):
        t = self.make_transcript(1)
        for _ in range(3):
            self.run_hook(json.dumps({"session_id": "s1", "transcript_path": t}))
        self.assertEqual(os.listdir(self.dst), ["s1.jsonl"])

    def test_missing_transcript_still_exits_zero(self):
        p, _ = self.run_hook(json.dumps({"session_id": "s", "transcript_path": os.path.join(self.tmp, "nope.jsonl")}))
        self.assertEqual(p.returncode, 0)
        self.assertIn("summary", p.stdout)

    def test_garbage_and_empty_stdin_exit_zero(self):
        for s in ("not json at all", "", "[1,2,3]", "null"):
            p, _ = self.run_hook(s)
            self.assertEqual(p.returncode, 0, s)

    def test_unwritable_backup_dir_exits_zero(self):
        blocker = os.path.join(self.tmp, "blocker")
        open(blocker, "w").close()
        self.dst = blocker  # a file where a folder is needed
        t = self.make_transcript(1)
        p, _ = self.run_hook(json.dumps({"session_id": "s", "transcript_path": t}))
        self.assertEqual(p.returncode, 0)

    def test_session_id_cannot_escape_the_folder(self):
        t = self.make_transcript(1)
        self.run_hook(json.dumps({"session_id": "../../evil", "transcript_path": t}))
        self.assertEqual(len(os.listdir(self.dst)), 1)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil.jsonl")))
        self.assertTrue(os.path.isfile(os.path.join(self.dst, os.listdir(self.dst)[0])))

    def test_large_real_transcript_is_fast_enough(self):
        big = os.environ.get("MA_BIG_TRANSCRIPT")
        if not big or not os.path.isfile(big):
            self.skipTest("set MA_BIG_TRANSCRIPT to a large transcript to time the copy")
        p, secs = self.run_hook(json.dumps({"session_id": "big", "transcript_path": big}))
        self.assertEqual(p.returncode, 0)
        print("\ncopied %.0f MB in %.2f s" % (os.path.getsize(big) / 1e6, secs))
        self.assertEqual(sha(os.path.join(self.dst, "big.jsonl")), sha(big))


if __name__ == "__main__":
    unittest.main(verbosity=2)
