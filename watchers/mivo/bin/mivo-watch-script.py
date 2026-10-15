#!/usr/bin/env python3
"""Cindy script-mode Mivo watcher dry-run. Does not create sessions by default."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import importlib.util
import itertools
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTOCOL_CANDIDATES = [
    HERE / "protocol.py",
]


def watcher_home() -> Path:
    """Resolve the watcher beside this wrapper in source and deployed layouts."""
    explicit = os.environ.get("MIVO_WATCHER_HOME")
    if explicit:
        candidate = Path(explicit).expanduser()
        if (candidate / "bin" / "mivo-watcher.mjs").exists():
            return candidate
        if (candidate / "mivo-watcher.mjs").exists():
            return candidate
        # Keep an explicit override useful for first deployment/state creation.
        return candidate
    return HERE.parent if HERE.name == "bin" else HERE


def watcher_path() -> Path:
    root = watcher_home()
    direct = root / "mivo-watcher.mjs"
    nested = root / "bin" / "mivo-watcher.mjs"
    if direct.exists():
        return direct
    return nested


def node_path() -> str:
    configured = os.environ.get("MIVO_NODE_BIN")
    if configured:
        return configured
    discovered = shutil.which("node")
    if discovered:
        return discovered
    raise RuntimeError("node executable not found; set MIVO_NODE_BIN")


def _import_client():
    for candidate in PROTOCOL_CANDIDATES:
        if candidate.exists():
            sys.path.insert(0, str(candidate.parent))
            break
    from protocol import DuplexClient  # type: ignore
    return DuplexClient()


def _summary(scan: dict) -> dict:
    """Keep completion evidence bounded and exclude feedback bodies."""
    def scrub(value):
        if isinstance(value, dict):
            return {
                key: scrub(item)
                for key, item in value.items()
                if key not in {"feedback", "body", "message"}
            }
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    complete = scrub({
        "mode": scan.get("mode"),
        "dispatch": bool(scan.get("dispatch")),
        "launchAgentLoaded": False,
        "viewer": scan.get("viewer"),
        "repo": scan.get("repo"),
        "prs": scan.get("prs", []),
        "events": scan.get("events", []),
        "statePath": scan.get("statePath"),
    })
    encoded = json.dumps(complete, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 7800:
        # Preserve protocol evidence while bounding arbitrary PR metadata.
        complete["prs"] = []
        complete["truncated"] = True
    return complete


class ConcurrentCalls:
    """Lets several host calls be in flight at once.

    protocol.DuplexClient waits for each call_result before the next call; discover now dispatches every PR of a
    pass at once. One reader thread routes call_result frames by id. The host accepts at most 16 in-flight calls,
    so calls above that wait here instead of failing with TOO_MANY_REQUESTS.
    """

    def __init__(self, client, limit: int = 12):
        self._client = client
        self._write_lock = threading.Lock()
        self._waiters: dict[str, list] = {}
        self._waiters_lock = threading.Lock()
        self._ids = itertools.count(1)
        self._slots = threading.BoundedSemaphore(limit)
        self._closed: Exception | None = None
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        try:
            while True:
                frame = self._client._read_frame()
                if frame.get("type") != "call_result":
                    raise RuntimeError("unexpected host frame while calls are in flight")
                with self._waiters_lock:
                    waiter = self._waiters.pop(str(frame.get("id")), None)
                if waiter is None:
                    raise RuntimeError("host answered an unknown call id")
                waiter[1] = frame
                waiter[0].set()
        except Exception as error:  # fail every pending and later call instead of hanging
            with self._waiters_lock:
                self._closed = error
                pending = list(self._waiters.values())
                self._waiters.clear()
            for waiter in pending:
                waiter[2] = error
                waiter[0].set()

    def write(self, frame: dict) -> None:
        with self._write_lock:
            self._client._write_frame(frame)

    def call(self, method: str, params: dict):
        with self._slots:
            request_id = f"pyc-{next(self._ids)}"
            waiter = [threading.Event(), None, None]
            with self._waiters_lock:
                if self._closed is not None:
                    raise RuntimeError(f"host channel closed: {self._closed}")
                self._waiters[request_id] = waiter
            self.write({"type": "call", "id": request_id, "method": method, "params": params})
            waiter[0].wait()
        if waiter[2] is not None:
            raise RuntimeError(f"host channel closed: {waiter[2]}")
        response = waiter[1]
        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") if isinstance(response.get("error"), dict) else {}
        raise RuntimeError(f"{error.get('code', 'INTERNAL')}: {error.get('message', 'host call failed')}")

    def emit_complete(self, result_text: str) -> None:
        self.write({"type": "complete", "resultText": result_text, "primarySessionId": None})


def _drain(stream, sink):
    try:
        for chunk in iter(stream.readline, ""):
            sink.append(chunk)
    finally:
        stream.close()


def _run_watcher(env: dict[str, str], watcher: Path, node: str, client, live: bool) -> dict:
    """client must offer call(method, params); dispatch frames are answered on worker threads."""
    process = subprocess.Popen(
        [node, str(watcher)],
        env=env,
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
    )
    assert process.stdout is not None and process.stdin is not None and process.stderr is not None
    stderr_chunks: list[str] = []
    stderr_thread = threading.Thread(target=_drain, args=(process.stderr, stderr_chunks), daemon=True)
    stderr_thread.start()
    scan = None
    stdin_lock = threading.Lock()
    workers: list[threading.Thread] = []

    def answer(frame: dict) -> None:
        try:
            receipt = client.call("sessions.dispatch", frame["params"])
            response = {"type": "receipt", "id": frame.get("id"), "receipt": receipt}
        except Exception as error:  # unblock Node with an explicit rejection
            response = {"type": "receipt", "id": frame.get("id"), "error": str(error)}
        with stdin_lock:
            try:
                process.stdin.write(json.dumps(response, ensure_ascii=False) + "\n")
                process.stdin.flush()
            except (OSError, ValueError):
                pass  # Node already finished; its own timeout keeps the dispatch pending

    try:
        for line in process.stdout:
            if not line.strip():
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"watcher produced non-protocol output: {line.strip()}") from error
            if not isinstance(frame, dict):
                raise RuntimeError("watcher produced a non-object protocol frame")
            if frame.get("type") == "dispatch":
                if not live:
                    raise RuntimeError("watcher requested dispatch while live mode is disabled")
                if not isinstance(frame.get("id"), str) or not frame["id"]:
                    raise RuntimeError("watcher dispatch frame missing id")
                if not isinstance(frame.get("params"), dict):
                    raise RuntimeError("watcher dispatch frame missing params")
                worker = threading.Thread(target=answer, args=(frame,), daemon=True)
                worker.start()
                workers.append(worker)
            elif "mode" in frame and "prs" in frame:
                scan = frame
                break
            else:
                raise RuntimeError("watcher protocol frame missing scan result")
    finally:
        join_until = time.monotonic() + 70
        for worker in workers:
            worker.join(timeout=max(0, join_until - time.monotonic()))
        try:
            with stdin_lock:
                process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
    process.wait()
    stderr_thread.join(timeout=5)
    error_text = "".join(stderr_chunks).strip()
    if len(error_text.encode("utf-8")) > 7800:
        error_text = error_text[:7600] + "\n...[stderr truncated]"
    if process.returncode:
        raise RuntimeError(error_text or f"watcher exited {process.returncode}")
    if scan is None:
        raise RuntimeError(error_text or "watcher produced no scan result")
    return scan


def parse_args(argv: list[str]) -> tuple[str, str | None, str | None]:
    mode = "discover"
    pr = None
    node_id = None
    args = list(argv)
    i = 0
    while i < len(args):
        if args[i] == "--mode" and i + 1 < len(args):
            mode = args[i + 1]; i += 2; continue
        if args[i] == "--pr" and i + 1 < len(args):
            pr = args[i + 1]; i += 2; continue
        if args[i] == "--node-id" and i + 1 < len(args):
            node_id = args[i + 1]; i += 2; continue
        i += 1
    if mode not in {"discover", "poll"}:
        raise SystemExit("--mode must be discover or poll")
    if mode == "poll" and (not pr or not node_id):
        raise SystemExit("poll mode requires --pr and --node-id")
    return mode, pr, node_id


def main() -> None:
    if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
        raise SystemExit("必须在 Cindy script 调度下运行，拒绝空跑")
    mode, pr, node_id = parse_args(sys.argv[1:])
    client = _import_client()
    if hasattr(client, "_ensure_started"):
        client._ensure_started()
    capabilities = client.call("host.capabilities", {})
    granted = capabilities.get("granted") if isinstance(capabilities, dict) else []
    if "sessions.dispatch" not in (granted or []):
        raise SystemExit("sessions.dispatch not granted")

    watcher = watcher_path()
    if not watcher.exists():
        raise SystemExit(f"watcher script not found: {watcher}")
    node = node_path()
    home = watcher_home()
    env = os.environ.copy()
    env["MIVO_WATCHER_HOME"] = str(home)
    env["MIVO_WATCHER_MODE"] = mode
    if pr:
        env["MIVO_WATCHER_PR"] = pr
    if node_id:
        env["MIVO_WATCHER_NODE_ID"] = node_id
    # Live dispatch is fail-closed: the scheduler must explicitly opt in after
    # granting sessions.dispatch. Capability discovery alone never enables it.
    live = os.environ.get("MIVO_WATCHER_LIVE") == "1"
    maintenance_path = HERE / "session-title-maintenance.py"
    pending = None
    if live and mode == "discover" and maintenance_path.exists():
        spec = importlib.util.spec_from_file_location("session_title_maintenance", maintenance_path)
        maintenance = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(maintenance)
        pending = maintenance.run_title_maintenance(home, client)
        if pending:
            env["MIVO_MAINTENANCE_SESSION"] = pending["targetSessionId"]
    env["MIVO_WATCHER_ENABLED"] = "1" if live else "0"
    env["MIVO_WATCHER_DISPATCH"] = "1" if live else "0"
    if live:
        env["MIVO_CINDY_BRIDGE"] = "1"
    calls = ConcurrentCalls(client)
    scan = _run_watcher(env, watcher, node, calls, live)
    summary = _summary(scan)
    if pending:
        summary["maintenance"] = pending
    calls.emit_complete(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
