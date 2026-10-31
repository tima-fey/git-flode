"""Pull-only Git operations for the configured FLODE checkout."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .project_lock import project_lock


class GitError(ValueError):
    """An operation could not be completed without discarding local work."""


class GitRepository:
    """Manage main and detached historical revisions; never reset, stash, or push."""

    def __init__(self, directory: str) -> None:
        if not directory or not Path(directory).is_absolute():
            raise GitError("Configure an absolute FLODE repository root first")
        self.root = Path(directory).resolve(strict=True)
        if self._git("rev-parse", "--show-toplevel") != str(self.root):
            raise GitError("The configured FLODE directory must be the Git repository root")
        if not self._ref("refs/heads/main"):
            raise GitError("The repository must have a main branch")

    def _git(self, *args: str, check: bool = True) -> str:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        try:
            result = subprocess.run(
                ["git", "-c", f"safe.directory={self.root}",
                 "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false",
                 *args],
                cwd=self.root, env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30, check=False,
            )
        except FileNotFoundError as error:
            raise GitError("Git is not installed in the HA runtime") from error
        except subprocess.TimeoutExpired as error:
            raise GitError("Git timed out; check remote access and authentication") from error
        if result.returncode and check:
            # Never return credentials embedded in remote URLs to the UI or logs.
            message = re.sub(r"\b(?:https?|ssh|file)://\S+", "[remote]", result.stderr)
            raise GitError(message.strip()[-2000:] or "Git operation failed")
        return result.stdout.strip() if not result.returncode else ""

    def _ref(self, ref: str) -> str:
        return self._git("rev-parse", "--verify", ref, check=False)

    def _clean(self) -> None:
        if self._git("status", "--porcelain=v1", "--untracked-files=normal"):
            raise GitError("Local changes exist; Git will not overwrite them")
        for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
            path = Path(self._git("rev-parse", "--git-path", marker))
            if (self.root / path).exists():
                raise GitError("Another Git operation is in progress")

    def _fetch(self) -> None:
        self._git("-c", "fetch.recurseSubmodules=false", "fetch", "--no-tags", "origin",
                  "+refs/heads/main:refs/remotes/origin/main")

    def _status(self) -> dict[str, Any]:
        head = self._ref("HEAD")
        remote = self._ref("refs/remotes/origin/main")
        ahead = behind = 0
        if remote:
            ahead, behind = map(int, self._git(
                "rev-list", "--left-right", "--count", "main...refs/remotes/origin/main"
            ).split())
        return {
            "commit": head, "short": self._git("rev-parse", "--short", "HEAD"),
            "branch": self._git("symbolic-ref", "--short", "-q", "HEAD", check=False) or None,
            "dirty": bool(self._git("status", "--porcelain=v1", "--untracked-files=normal")),
            "main": self._ref("refs/heads/main"), "remote": remote or None,
            "has_origin": "origin" in self._git("remote").splitlines(),
            "ahead": ahead, "behind": behind,
        }

    def _history(self, offset: int) -> dict[str, Any]:
        refs = ["refs/heads/main"]
        if self._ref("refs/remotes/origin/main"):
            refs.append("refs/remotes/origin/main")
        lines = self._git("log", "--date-order", "--format=%H%x09%h%x09%cs%x09%s",
                          f"--skip={offset}", "--max-count=26", *refs, "--").splitlines()
        commits = []
        for line in lines[:25]:
            commit, short, date, subject = line.split("\t", 3)
            commits.append({"commit": commit, "short": short, "date": date, "subject": subject})
        return {"commits": commits, "has_more": len(lines) > 25}

    def request(
        self, action: str, *, expected_head: str = "", revision: str = "", offset: int = 0
    ) -> dict[str, Any]:
        """Serialize clients; stale requests cannot change a newer checkout."""
        lock = project_lock(str(self.root))
        if not lock.acquire(timeout=1):
            raise GitError("Another Git or test request is running; try again when it finishes")
        try:
            if action == "status":
                return self._status()
            if action == "history":
                return self._history(offset)
            if action == "fetch":
                self._fetch()
                return self._status()
            if action not in ("pull", "main", "checkout"):
                raise GitError("Unsupported Git operation")
            if self._ref("HEAD") != expected_head:
                raise GitError("The checkout changed; refresh Git status and try again")
            self._clean()
            branch = self._git("symbolic-ref", "--short", "-q", "HEAD", check=False)
            if branch not in ("", "main"):
                raise GitError("Only main and detached historical revisions are supported")
            if action == "pull":
                if branch != "main":
                    raise GitError("Return to main before pulling")
                self._fetch()
                self._clean()
                if self._ref("HEAD") != expected_head:
                    raise GitError("The checkout changed during fetch; refresh Git status")
                self._git("merge", "--ff-only", "refs/remotes/origin/main")
            elif action == "main":
                self._git("switch", "main")
            else:
                if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
                    raise GitError("Select a full commit hash from main's history")
                reachable = any(self._git("merge-base", ref, revision, check=False) == revision
                                for ref in ("refs/heads/main", "refs/remotes/origin/main"))
                if not reachable:
                    raise GitError("The commit is not in main's history; fetch or refresh history")
                self._git("switch", "--detach", revision)
            return self._status()
        finally:
            lock.release()
