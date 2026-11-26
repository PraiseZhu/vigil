import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
PROTOCOL = "cindy-script/1"
TARGET = "example-companion"


def frame(kind, **fields):
    return json.dumps({"protocol": PROTOCOL, "type": kind, **fields}) + "\n"


class StewardScriptTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="vigil-steward-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.state = self.home / "state"
        self.outbox = self.state / "outbox"
        config = self.home / "profile.json"
        config.write_text(json.dumps({
            "authors": ["ExampleUser"],
            "repos": ["example-org/example-repo"],
            "stateDir": "state",
        }), encoding="utf-8")
        fake_gh = self.home / "gh"
        shutil.copyfile(HERE / "fixtures/script/fake-gh.sh", fake_gh)
        fake_gh.chmod(0o700)
        self.env = {
            "PATH": str(self.home) + os.pathsep + os.environ["PATH"],
            "HOME": str(self.home),
            "STEWARD_PROFILE": str(config),
            "CINDY_SCRIPT_PROTOCOL": "1",
        }

    def seed(self, count=3, types=None):
        directory = self.outbox / "orders"
        directory.mkdir(parents=True)
        ids = []
        for number in range(count, 0, -1):
            order_id = hashlib.sha256(str(number).encode()).hexdigest()
            ids.append(order_id)
            (directory / f"{order_id}.json").write_text(json.dumps({
                "id": order_id, "type": types[number - 1] if types else "ensure_follower",
                "pr": f"example-org/example-repo#{number}", "head": "a" * 40,
                "reason": "需要跟进", "created_at": "2026-01-01T00:00:00Z",
                "attempts": 0, "delivered": False, "payload": {},
            }), encoding="utf-8")
        return ids

    def run_host(self, ok=True, target=TARGET, reply_target=TARGET):
        wire = frame("start", context={"targetSessionId": target} if target else {})
        fields = {"result": {"target_session_id": reply_target, "wake_kind": "queued"}} if ok else {
            "error": {"code": "FIXTURE_FAILURE", "message": "fixture dispatch rejected"},
        }
        wire += frame("call_result", id="py-1", ok=ok, **fields)
        result = subprocess.run(
            [sys.executable, "-B", str(HERE / "bin/steward-script.py")],
            cwd=self.home, env=self.env, input=wire, capture_output=True,
            encoding="utf-8", timeout=15,
        )
        frames = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(all(item["protocol"] == PROTOCOL for item in frames))
        return result, frames

    def assert_delivery(self, ids, delivered):
        for order_id in ids:
            original = json.loads((self.outbox / "orders" / f"{order_id}.json").read_text())
            self.assertIs(original["delivered"], delivered)
            self.assertEqual(original["attempts"], int(delivered))
            mark = self.outbox / "deliveries" / f"{order_id}.json"
            self.assertEqual(mark.exists(), delivered)
            if delivered:
                audit = json.loads(mark.read_text())
                self.assertGreater(audit["delivered_at"], original["created_at"])

    def test_sc1_empty_outbox_does_not_dispatch(self):
        result, frames = self.run_host()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item["type"] for item in frames], ["complete"])
        scan = json.loads((self.state / "last-scan.json").read_text())
        self.assertTrue(scan["scanned_at"])
        self.assertEqual(scan["prs"], [])
        self.assertEqual(scan["discoveryErrors"], [])

    def test_sc2_batches_three_orders_and_marks_only_on_success(self):
        ids = self.seed()
        result, frames = self.run_host()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item["type"] for item in frames], ["call", "complete"])
        self.assertEqual(frames[0]["method"], "sessions.dispatch")
        params = frames[0]["params"]
        self.assertEqual(params["target_session_id"], TARGET)
        for order_id in ids:
            self.assertIn(f"--order {order_id}", params["message"])
        self.assertIn("https://github.com/example-org/example-repo/pull/1", params["message"])
        self.assert_delivery(ids, True)
        result, frames = self.run_host()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item["type"] for item in frames], ["complete"])
        self.assert_delivery(ids, True)

    def test_sc2_sc3_dispatch_failure_keeps_state_and_retry_key(self):
        ids = self.seed()
        result, frames = self.run_host(ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FIXTURE_FAILURE", result.stderr)
        self.assertEqual([item["type"] for item in frames], ["call"])
        self.assert_delivery(ids, False)
        expected = hashlib.sha256(json.dumps(sorted(ids), separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(frames[0]["params"]["idempotency_key"], expected)
        retry, frames = self.run_host()
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(frames[0]["params"]["idempotency_key"], expected)
        self.assert_delivery(ids, True)

    def test_no_success_for_unconfirmed_target(self):
        ids = self.seed()
        result, frames = self.run_host(reply_target="another-session")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("未确认目标会话", result.stderr)
        self.assertEqual([item["type"] for item in frames], ["call"])
        self.assert_delivery(ids, False)

    def test_halted_pr_dispatches_only_its_stop_order(self):
        other, stop, old = self.seed(types=["nudge", "stop_and_notify", "ensure_follower"])
        pr = "example-org/example-repo#1"
        order_file = self.outbox / "orders" / f"{stop}.json"
        stop_order = json.loads(order_file.read_text())
        order_file.write_text(json.dumps({**stop_order, "pr": pr}), encoding="utf-8")
        pr_dir = self.state / "prs"
        pr_dir.mkdir()
        pr_key = hashlib.sha256(pr.encode()).hexdigest()
        (pr_dir / f"{pr_key}.json").write_text(json.dumps({
            "pr": pr, "head": "a" * 40, "classification": "要修", "halted": True,
        }), encoding="utf-8")
        result, frames = self.run_host()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item["type"] for item in frames], ["call", "complete"])
        message = frames[0]["params"]["message"]
        self.assertIn(stop, message)
        self.assertIn(other, message)
        self.assertNotIn(old, message)
        self.assert_delivery([stop, other], True)
        self.assert_delivery([old], False)

    def test_sc4_tick_failure_uses_stderr_only_and_never_dispatches(self):
        ids = self.seed()
        self.env.pop("STEWARD_PROFILE")
        result, frames = self.run_host()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("STEWARD_PROFILE", result.stderr)
        self.assertEqual(frames, [])
        self.assert_delivery(ids, False)
        self.assertFalse((self.state / "last-scan.json").exists())

    def test_unbound_schedule_never_dispatches_or_mutates_state(self):
        ids = self.seed()
        result, frames = self.run_host(target=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("必须绑定", result.stderr)
        self.assertEqual(frames, [])
        self.assert_delivery(ids, False)
        self.assertFalse((self.state / "last-scan.json").exists())


if __name__ == "__main__":
    unittest.main()
