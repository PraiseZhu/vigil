#!/usr/bin/env python3
import importlib.util
import os
import queue
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "bin" / "cindy-watch-script.py"

# Emits three dispatch frames at once and prints the scan only after every receipt arrived, like discover
# does when a pass dispatches several PRs.
FAKE_WATCHER = r"""
import { createInterface } from 'node:readline';
const ids = ['d1', 'd2', 'd3'];
const receipts = new Map();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const frame = JSON.parse(line);
  receipts.set(frame.id, frame);
  if (receipts.size === ids.length) {
    process.stdout.write(JSON.stringify({ mode: 'discover', prs: ids.map((id) => receipts.get(id)) }) + '\n');
    rl.close();
  }
});
for (const id of ids) process.stdout.write(JSON.stringify({ type: 'dispatch', id, params: { id } }) + '\n');
"""


def load_watch():
    spec = importlib.util.spec_from_file_location("cindy_watch_script", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SummaryTests(unittest.TestCase):
    def test_keeps_orphan_guards_and_detail(self):
        out = load_watch()._summary({
            "mode": "discover",
            "dispatch": False,
            "orphanGuards": 2,
            "detail": "有 2 个孤立接管守卫，用 lock-doctor 清理",
            "prs": [{"number": 1, "feedback": "drop me"}],
            "events": [],
        })
        self.assertEqual(out["orphanGuards"], 2)
        self.assertIn("孤立接管守卫", out["detail"])
        self.assertEqual(out["mode"], "discover")
        self.assertNotIn("feedback", out["prs"][0])

    def test_zero_orphan_guards_without_detail(self):
        out = load_watch()._summary({"mode": "discover", "orphanGuards": 0, "prs": []})
        self.assertEqual(out["orphanGuards"], 0)
        self.assertNotIn("detail", out)


class SlowClient:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = 0
        self.peak = 0

    def call(self, method, params):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        time.sleep(0.4)
        with self.lock:
            self.active -= 1
        return {"target_session_id": f"s-{params['id']}"}


class FakeTransport:
    """Host side of the protocol: frames written by the script land in `written`, answers go through `inbox`."""

    def __init__(self):
        self.inbox = queue.Queue()
        self.written = queue.Queue()

    def _read_frame(self):
        frame = self.inbox.get()
        if isinstance(frame, Exception):
            raise frame
        return frame

    def _write_frame(self, frame):
        self.written.put(frame)


class DispatchTests(unittest.TestCase):
    def test_dispatch_frames_are_answered_concurrently(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        mod = load_watch()
        with tempfile.TemporaryDirectory() as tmp:
            watcher = Path(tmp) / "fake-watcher.mjs"
            watcher.write_text(FAKE_WATCHER, encoding="utf-8")
            client = SlowClient()
            started = time.monotonic()
            scan = mod._run_watcher(dict(os.environ), watcher, node, client, live=True)
            elapsed = time.monotonic() - started
        self.assertEqual([item["receipt"]["target_session_id"] for item in scan["prs"]], ["s-d1", "s-d2", "s-d3"])
        self.assertEqual(client.peak, 3)
        self.assertLess(elapsed, 1.1, "three 0.4 s dispatches ran one after another")


class ConcurrentCallsTests(unittest.TestCase):
    def test_answers_are_routed_by_id_in_any_order(self):
        transport = FakeTransport()
        calls = load_watch().ConcurrentCalls(transport)
        results = {}
        threads = [threading.Thread(target=lambda n=n: results.__setitem__(n, calls.call("sessions.dispatch", {"n": n})))
                   for n in (1, 2)]
        for thread in threads:
            thread.start()
        sent = [transport.written.get(timeout=2), transport.written.get(timeout=2)]
        for frame in reversed(sent):
            transport.inbox.put({"type": "call_result", "id": frame["id"], "ok": True, "result": frame["params"]["n"] * 10})
        for thread in threads:
            thread.join(timeout=2)
        self.assertEqual(results, {1: 10, 2: 20})

    def test_closed_channel_fails_pending_calls(self):
        transport = FakeTransport()
        calls = load_watch().ConcurrentCalls(transport)
        errors = []

        def call():
            try:
                calls.call("sessions.dispatch", {})
            except RuntimeError as error:
                errors.append(str(error))

        thread = threading.Thread(target=call)
        thread.start()
        transport.written.get(timeout=2)
        transport.inbox.put(EOFError("host closed the script channel"))
        thread.join(timeout=2)
        self.assertEqual(len(errors), 1)
        self.assertIn("host channel closed", errors[0])

    def test_host_error_is_raised_with_code(self):
        transport = FakeTransport()
        calls = load_watch().ConcurrentCalls(transport)
        errors = []
        thread = threading.Thread(target=lambda: errors.append(self._call_error(calls)))
        thread.start()
        frame = transport.written.get(timeout=2)
        transport.inbox.put({"type": "call_result", "id": frame["id"], "ok": False,
                             "error": {"code": "NOT_FOUND", "message": "session archived"}})
        thread.join(timeout=2)
        self.assertEqual(errors, ["NOT_FOUND: session archived"])

    @staticmethod
    def _call_error(calls):
        try:
            calls.call("sessions.dispatch", {})
        except RuntimeError as error:
            return str(error)
        return None


if __name__ == "__main__":
    unittest.main()
