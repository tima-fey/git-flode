"""Shared checkout locks for Git operations and project test runs."""
from __future__ import annotations

import threading

_LOCKS: dict[str, threading.Lock] = {}


def project_lock(directory: str) -> threading.Lock:
    """Return the process-local lock for a canonical project root."""
    return _LOCKS.setdefault(directory, threading.Lock())
