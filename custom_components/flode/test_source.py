"""Run trusted project Python tests in a bounded, separate process."""
from __future__ import annotations

import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .project_lock import project_lock

TIMEOUT = 60
OUTPUT_LIMIT = 64 * 1024


def run_tests(directory: str) -> dict[str, Any]:
    """Execute unittest from tests/, never installing project dependencies."""
    root = Path(directory)
    if not directory or not root.is_absolute():
        raise ValueError("Configure an absolute FLODE project root first")
    root = root.resolve(strict=True)
    tests = root / "tests"
    if tests.is_symlink() or not tests.is_dir():
        raise ValueError("The project must contain a tests/ directory")
    if any(path.is_symlink() for path in tests.rglob("*")):
        raise ValueError("Symlinks are not supported in tests/")
    lock = project_lock(str(root))
    if not lock.acquire(timeout=1):
        raise ValueError("Another Git or test request is running; try again when it finishes")
    try:
        return _execute(root)
    finally:
        lock.release()


def _execute(root: Path) -> dict[str, Any]:
    started = time.monotonic()
    output = bytearray()
    truncated = timed_out = False
    worker = Path(__file__).with_name("run_project_tests.py")
    with subprocess.Popen(
        [sys.executable, "-I", "-B", str(worker), str(root)],
        cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    ) as process, selectors.DefaultSelector() as selector:
        if process.stdout is None:
            raise RuntimeError("Unable to capture test output")
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while selector.get_map():
                remaining = TIMEOUT - (time.monotonic() - started)
                if remaining <= 0:
                    timed_out = True
                    break
                for key, _ in selector.select(min(remaining, 0.2)):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    available = OUTPUT_LIMIT - len(output)
                    output.extend(chunk[:available])
                    truncated = truncated or len(chunk) > available
            if not timed_out:
                try:
                    process.wait(timeout=max(0.01, TIMEOUT - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    timed_out = True
        finally:
            # Clean up the worker and subprocesses in its process group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    return {
        "success": not timed_out and process.returncode == 0,
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "truncated": truncated,
        "output": output.decode("utf-8", errors="replace"),
        "duration": round(time.monotonic() - started, 3),
    }
