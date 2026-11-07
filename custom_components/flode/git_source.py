"""Explicit prod-branch Git operations for the configured FLODE checkout."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from contextlib import contextmanager
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

    def _git(self, *args: str, check: bool = True, identity: tuple[str, str] | None = None, index: str | None = None) -> str:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        if index is not None:
            env["GIT_INDEX_FILE"] = index
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
        if result.returncode:
            return ""
        return result.stdout if "-z" in args else result.stdout.strip()

    def _ref(self, ref: str) -> str:
        return self._git("rev-parse", "--verify", ref, check=False)

    def _clean(self) -> None:
        if self._git("status", "--porcelain=v1", "--untracked-files=all"):
            raise GitError("Local changes exist; Git will not overwrite them")
        self._idle()

    def _protect_ignored(self, revision: str) -> None:
        """Reject only ignored paths that the destination tree could replace."""
        ignored = list(filter(None, self._git("ls-files", "--others", "--ignored", "--exclude-standard", "-z").split("\0")))
        if not ignored:
            return
        destination = list(filter(None, self._git("ls-tree", "-r", "--name-only", "-z", revision, "--").split("\0")))
        if any(local == tracked or local.startswith(tracked + "/") or tracked.startswith(local + "/")
               for local in ignored for tracked in destination):
            raise GitError("Local changes include ignored files that Git could overwrite")

    def _idle(self) -> None:
        for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
            path = Path(self._git("rev-parse", "--git-path", marker))
            if (self.root / path).exists():
                raise GitError("Another Git operation is in progress")

    def _fetch(self) -> None:
        fetch_urls = self._git("remote", "get-url", "--all", "origin").splitlines()
        push_urls = self._git("remote", "get-url", "--push", "--all", "origin").splitlines()
        if len(fetch_urls) != 1 or push_urls != fetch_urls:
            raise GitError("origin must have one identical fetch and push destination")
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
        self._protect_ignored(incoming)
        identity = self._identity()
        try:
            self._git("-c", "commit.gpgsign=false", "merge", "--no-overwrite-ignore", "--no-ff", "--no-edit", "--no-verify",
                      "-m", f"Merge origin/main into prod\n\nFLODE-Main-Merge: {incoming}", incoming, identity=identity)
        except GitError as error:
            self._abort("merge", expected_head)
            raise GitError("Merge failed; previous prod was restored. Merge prod into main on your computer, resolve conflicts, push main, then retry. " + str(error)) from error

    @contextmanager
    def _snapshot(self):
        """Stage a private index; neither review nor commit stages live files."""
        with tempfile.TemporaryDirectory(prefix="flode-index-") as directory:
            index = str(Path(directory) / "index")
            self._git("read-tree", "HEAD", index=index)
            self._git("add", "--all", "--", ".", index=index)
            yield index, self._git("write-tree", index=index)

    def _review(self, tree: str) -> dict[str, Any]:
        options = ("--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames")
        patch = self._git("diff", *options, "HEAD", tree, "--", ":(exclude,top)objects/").encode()
        objects_patch = self._git("diff", *options, "HEAD", tree, "--", ":(top)objects/").encode()
        staged = self._git("diff", "--cached", *options, "HEAD", "--")
        digest = sha256(json.dumps([str(self.root), self._ref("HEAD"), tree, staged]).encode())
        files = list(filter(None, self._git("diff", "--name-only", "--no-renames", "-z", "HEAD", tree, "--").split("\0")))
        limit = 64 * 1024
        return {"files": files, "diff": patch[:limit].decode("utf-8", errors="replace"),
                "version": digest.hexdigest(), "truncated": len(patch) > limit,
                "objects_diff": {"diff": objects_patch[:limit].decode("utf-8", errors="replace"),
                                 "truncated": len(objects_patch) > limit}}

    def _changes(self) -> dict[str, Any]:
        """Review the exact tree that committing will validate and publish."""
        with self._snapshot() as (_, tree):
            return self._review(tree)

    def _revision(self, revision: str) -> None:
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
            raise GitError("Select a full commit hash from history")
        if not any(self._git("merge-base", ref, revision, check=False) == revision
                   for ref in ("refs/heads/prod", "refs/remotes/origin/main", "refs/remotes/origin/prod") if self._ref(ref)):
            raise GitError("The commit is not in prod or main history; fetch or refresh history")

    def _show(self, revision: str) -> dict[str, Any]:
        self._revision(revision)
        patch = self._git("show", "--format=fuller", "--diff-merges=first-parent", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", revision, "--")
        limit = 64 * 1024
        return {"revision": revision, "diff": patch.encode()[:limit].decode("utf-8", errors="replace"),
                "truncated": len(patch.encode()) > limit}

    def _commit(self, expected_head: str, expected_changes: str, message: str, identity: tuple[str, str]) -> None:
        # The real index lock prevents external staging from being overwritten.
        index_path = Path(self._git("rev-parse", "--git-path", "index"))
        if not index_path.is_absolute():
            index_path = self.root / index_path
        lock_path = index_path.with_name(index_path.name + ".lock")
        try:
            lock = lock_path.open("xb")
        except FileExistsError as error:
            raise GitError("Another Git operation is updating the index") from error
        try:
            with lock, self._snapshot() as (index, tree):
                review = self._review(tree)
                if review["version"] != expected_changes:
                    raise GitError("Files or staging changed; review changes again before committing")
                if not review["files"]:
                    raise GitError("No working-file changes to commit")
                commit = self._git("-c", "commit.gpgsign=false", "commit-tree", tree, "-p", expected_head,
                                   "-m", message.strip(), identity=identity)
                self._git("update-ref", "refs/heads/prod", commit, expected_head)
                lock.write(Path(index).read_bytes())
            os.replace(lock_path, index_path)
        finally:
            lock_path.unlink(missing_ok=True)

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
            if action == "show":
                return self._show(revision)
            if action == "history":
                return self._history(offset)
            if action not in ("fetch", "merge", "prod", "commit", "push", "revert"):
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
                self._protect_ignored("refs/heads/prod")
                self._git("switch", "--no-overwrite-ignore", "prod")
                return self._status()
            if branch != "prod":
                raise GitError("Return to prod before committing, merging, reverting, or pushing")
            if action == "commit":
                if not message.strip() or len(message) > 4000 or "\0" in message:
                    raise GitError("Enter a commit message (up to 4000 characters)")
                identity = self._identity()
                self._commit(expected_head, expected_changes, message, identity)
            elif action == "push":
                self._fetch()
                self._unchanged(expected_head)
                self._prod_not_rewritten()
                push_error = None
                try:
                    self._git("-c", "push.followTags=false", "push", "--no-verify", "--recurse-submodules=no",
                              "origin", "refs/heads/prod:refs/heads/prod")
                except GitError as error:
                    push_error = error
                try:
                    self._fetch()
                except GitError as error:
                    raise GitError("Push outcome is unknown; fetch before retrying or changing prod") from error
                if self._ref("refs/remotes/origin/prod") != expected_head:
                    raise GitError("Push was not confirmed by the remote; fetch and review prod before retrying") from push_error
            else:
                self._clean()
                if action == "merge":
                    self._merge_main(expected_head)
                else:
                    if not revision or revision != self._merge_to_revert():
                        raise GitError("Only the latest FLODE main merge at the tip of prod can be undone; refresh history")
                    self._protect_ignored(revision + "^1")
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
    try:
        result = subprocess.run(
            ["git", "-c", f"safe.directory={root}", "rev-parse", "--show-toplevel"],
            cwd=root, env={**os.environ, "LC_ALL": "C"},
            capture_output=True, text=True, check=False, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitError("Cannot determine the project Git state; file changes are blocked") from error
    if result.returncode:
        # An invalid/inaccessible .git marker must never turn off write guards.
        try:
            markers = False
            for parent in (root, *root.parents):
                try:
                    (parent / ".git").lstat()
                except FileNotFoundError:
                    continue
                markers = True
                break
        except OSError as error:
            raise GitError("Cannot inspect the project Git state; file changes are blocked") from error
        if markers or not result.stderr.startswith("fatal: not a git repository (or any of the parent directories)"):
            raise GitError("Cannot determine the project Git state; file changes are blocked")
        return
    repository = GitRepository(str(root))
    if repository._git('symbolic-ref', '--short', '-q', 'HEAD', check=False) != 'prod':
        raise GitError('Return to prod before changing project files; historical revisions are read-only')
    repository._idle()
