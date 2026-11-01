"""Explicit prod-branch Git operations for the configured FLODE checkout."""
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

from .project_lock import project_lock


class GitError(ValueError):
    """An operation could not be completed without discarding local work."""


class GitRepository:
    """Manage prod and historical revisions without resets, stashes, or force pushes."""

    def __init__(self, directory: str) -> None:
        if not directory or not Path(directory).is_absolute():
            raise GitError("Configure an absolute FLODE repository root first")
        self.root = Path(directory).resolve(strict=True)
        if self._git("rev-parse", "--show-toplevel") != str(self.root):
            raise GitError("The configured FLODE directory must be the Git repository root")
        if not self._ref("refs/heads/prod"):
            raise GitError("The HA checkout must have an existing prod branch")

    def _git(self, *args: str, check: bool = True, identity: tuple[str, str] | None = None) -> str:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        if identity is not None:
            name, email = identity
            env.update(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                       GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email)
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
        self._idle()

    def _idle(self) -> None:
        for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
            path = Path(self._git("rev-parse", "--git-path", marker))
            if (self.root / path).exists():
                raise GitError("Another Git operation is in progress")

    def _fetch(self) -> None:
        self._git("-c", "fetch.recurseSubmodules=false", "fetch", "--no-tags", "origin",
                  "+refs/heads/main:refs/remotes/origin/main")
        remote_prod = self._git("ls-remote", "--heads", "origin", "refs/heads/prod")
        if remote_prod:
            self._git("-c", "fetch.recurseSubmodules=false", "fetch", "--no-tags", "origin",
                      "+refs/heads/prod:refs/remotes/origin/prod")
        elif self._ref("refs/remotes/origin/prod"):
            self._git("update-ref", "-d", "refs/remotes/origin/prod")

    def _identity(self) -> tuple[str, str]:
        name = self._git("config", "user.name", check=False).strip()
        email = self._git("config", "user.email", check=False).strip()
        if (len(name) > 256 or len(email) > 320 or not name or not email or "@" not in email
            or any(char.isspace() for char in email)
            or any(char in name + email for char in "\r\n\0<>")):
            raise GitError("Configure user.name and user.email in the project Git config before committing")
        return name, email

    def _merge_to_revert(self) -> str | None:
        parents = self._git("show", "-s", "--format=%P", "HEAD").split()
        if len(parents) == 2 and f"FLODE-Main-Merge: {parents[1]}" in self._git("show", "-s", "--format=%B", "HEAD").splitlines():
            return self._ref("HEAD")
        return None

    def _status(self) -> dict[str, Any]:
        head = self._ref("HEAD")
        prod = self._ref("refs/heads/prod")
        remote_main = self._ref("refs/remotes/origin/main")
        remote_prod = self._ref("refs/remotes/origin/prod")
        branch = self._git("symbolic-ref", "--short", "-q", "HEAD", check=False) or None
        ahead = behind = 0
        if prod and remote_prod:
            ahead, behind = map(int, self._git(
                "rev-list", "--left-right", "--count", "refs/heads/prod...refs/remotes/origin/prod"
            ).split())
        return {
            "directory": str(self.root), "commit": head,
            "short": self._git("rev-parse", "--short", "HEAD"), "branch": branch,
            "dirty": bool(self._git("status", "--porcelain=v1", "--untracked-files=normal")),
            "prod": prod, "remote_main": remote_main or None, "remote_prod": remote_prod or None,
            "has_origin": "origin" in self._git("remote").splitlines(),
            "ahead": ahead, "behind": behind,
            "incoming": int(self._git("rev-list", "--count", f"{prod or head}..{remote_main}")) if remote_main else 0,
            "merge_to_revert": self._merge_to_revert() if branch == "prod" else None,
        }

    def _unchanged(self, expected_head: str) -> None:
        if self._ref("HEAD") != expected_head:
            raise GitError("The checkout changed; refresh Git status and try again")

    def _prod_not_rewritten(self) -> None:
        remote = self._ref("refs/remotes/origin/prod")
        if remote and self._git("merge-base", "HEAD", remote, check=False) != remote:
            raise GitError("origin/prod has changes missing locally; another writer changed prod. Reconcile it outside HA before retrying")

    def _abort(self, operation: str, expected_head: str) -> None:
        marker = "MERGE_HEAD" if operation == "merge" else "REVERT_HEAD"
        if (self.root / self._git("rev-parse", "--git-path", marker)).exists():
            try:
                self._git(operation, "--abort")
            except GitError as error:
                raise GitError("Automatic Git abort failed; resolve the in-progress operation outside HA before retrying") from error
        self._unchanged(expected_head)
        self._clean()

    def _merge_main(self, expected_head: str) -> None:
        self._fetch()
        self._unchanged(expected_head)
        self._clean()
        self._prod_not_rewritten()
        incoming = self._ref("refs/remotes/origin/main")
        if self._git("merge-base", "HEAD", incoming, check=False) == incoming:
            return
        identity = self._identity()
        try:
            self._git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "--no-verify",
                      "-m", f"Merge origin/main into prod\n\nFLODE-Main-Merge: {incoming}", incoming, identity=identity)
        except GitError as error:
            self._abort("merge", expected_head)
            raise GitError("Merge failed; previous prod was restored. Merge prod into main on your computer, resolve conflicts, push main, then retry. " + str(error)) from error

    def _changes(self) -> dict[str, Any]:
        """Review working files (including untracked files) with a stale-review token."""
        options = ("--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames")
        patch = self._git("diff", *options, "HEAD", "--")
        staged = self._git("diff", "--cached", *options, "HEAD", "--")
        digest = sha256(json.dumps([str(self.root), self._ref("HEAD"), patch, staged]).encode())
        files = self._git("diff", "--name-only", "--no-renames", "-z", "HEAD", "--").split("\0")
        files = [file for file in files if file]
        limit = 64 * 1024
        preview = patch.encode()[:limit]
        truncated = len(patch.encode()) > limit
        untracked = self._git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
        for file in sorted(filter(None, untracked)):
            path = self.root / file
            info = path.lstat()
            content_hash = sha256()
            sample = bytearray()
            if stat.S_ISLNK(info.st_mode):
                content = os.readlink(path).encode()
                content_hash.update(content)
                sample.extend(content)
            elif stat.S_ISREG(info.st_mode):
                with path.open("rb") as handle:
                    while chunk := handle.read(65536):
                        content_hash.update(chunk)
                        if len(sample) < limit:
                            sample.extend(chunk[:limit - len(sample)])
                after = path.lstat()
                if (after.st_ino, after.st_dev, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_ino, info.st_dev, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns):
                    raise GitError("A file changed during review; review changes again")
            else:
                raise GitError("Untracked directories and special files cannot be committed here")
            files.append(file)
            digest.update(json.dumps([file, info.st_mode, content_hash.hexdigest()]).encode())
            addition = ("\n--- /dev/null\n+++ " + file + "\n").encode() + bytes(sample)
            available = limit - len(preview)
            preview += addition[:available]
            truncated = truncated or len(addition) > available or info.st_size > limit
        return {"files": files, "diff": preview.decode("utf-8", errors="replace"),
                "version": digest.hexdigest(), "truncated": truncated}

    def _history(self, offset: int) -> dict[str, Any]:
        refs = [ref for ref in ("refs/heads/prod", "refs/remotes/origin/main", "refs/remotes/origin/prod") if self._ref(ref)]
        if not refs:
            refs = ["HEAD"]
        lines = self._git("log", "--date-order", "--format=%H%x09%h%x09%cs%x09%s",
                          f"--skip={offset}", "--max-count=26", *refs, "--").splitlines()
        commits = []
        for line in lines[:25]:
            commit, short, date, subject = line.split("\t", 3)
            commits.append({"commit": commit, "short": short, "date": date, "subject": subject})
        return {"commits": commits, "has_more": len(lines) > 25}

    def request(
        self, action: str, *, expected_head: str = "", revision: str = "", offset: int = 0,
        expected_changes: str = "", message: str = "", expected_directory: str = ""
    ) -> dict[str, Any]:
        """Serialize clients; stale requests cannot change a newer checkout."""
        lock = project_lock(str(self.root))
        if not lock.acquire(timeout=1):
            raise GitError("Another Git or test request is running; try again when it finishes")
        try:
            if action == "status":
                return self._status()
            if action == "changes":
                return self._changes()
            if action == "history":
                return self._history(offset)
            if action not in ("fetch", "merge", "prod", "checkout", "commit", "push", "revert"):
                raise GitError("Unsupported Git operation")
            if expected_directory != str(self.root):
                raise GitError("The configured project changed; refresh Git status")
            if action == "fetch":
                self._fetch()
                return self._status()
            self._unchanged(expected_head)
            self._idle()
            branch = self._git("symbolic-ref", "--short", "-q", "HEAD", check=False)
            if branch not in ("", "prod"):
                raise GitError("Only prod and detached historical revisions are supported")
            if action == "prod":
                self._clean()
                self._git("switch", "prod")
                return self._status()
            if action == "checkout":
                self._clean()
                if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
                    raise GitError("Select a full commit hash from history")
                reachable = any(self._git("merge-base", ref, revision, check=False) == revision
                                for ref in ("refs/heads/prod", "refs/remotes/origin/main", "refs/remotes/origin/prod") if self._ref(ref))
                if not reachable:
                    raise GitError("The commit is not in prod or main history; fetch or refresh history")
                self._git("switch", "--detach", revision)
                return self._status()
            if branch != "prod":
                raise GitError("Return to prod before committing, merging, reverting, or pushing")
            if action == "commit":
                if not message.strip() or len(message) > 4000 or "\0" in message:
                    raise GitError("Enter a commit message (up to 4000 characters)")
                identity = self._identity()
                review = self._changes()
                if review["version"] != expected_changes:
                    raise GitError("Files or staging changed; review changes again before committing")
                if not review["files"]:
                    raise GitError("No working-file changes to commit")
                self._git("add", "--all", "--", ".")
                self._git("-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", message.strip(), identity=identity)
            elif action == "push":
                self._fetch()
                self._unchanged(expected_head)
                self._prod_not_rewritten()
                self._git("-c", "push.followTags=false", "push", "--no-verify", "--recurse-submodules=no",
                          "origin", "refs/heads/prod:refs/heads/prod")
                # Refresh only the published destination after a normal push.
                self._git("update-ref", "refs/remotes/origin/prod", self._ref("refs/heads/prod"))
            else:
                self._clean()
                if action == "merge":
                    self._merge_main(expected_head)
                else:
                    if not revision or revision != self._merge_to_revert():
                        raise GitError("Only the latest FLODE main merge at the tip of prod can be undone; refresh history")
                    identity = self._identity()
                    try:
                        self._git("-c", "commit.gpgsign=false", "revert", "--no-edit", "--mainline", "1", revision, identity=identity)
                    except GitError as error:
                        self._abort("revert", expected_head)
                        raise GitError("Undo merge failed; previous prod was restored. " + str(error)) from error
            return self._status()
        finally:
            lock.release()


def require_prod_for_writes(root: Path) -> None:
    """Guard Git-backed file mutations while the caller holds the project lock."""
    if (root / '.git').exists():
        repository = GitRepository(str(root))
        if repository._git('symbolic-ref', '--short', '-q', 'HEAD', check=False) != 'prod':
            raise GitError('Return to prod before changing project files; historical revisions are read-only')
        repository._idle()
