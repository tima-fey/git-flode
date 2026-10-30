"""Git synchronization uses disposable repositories and a local bare remote."""
import os
import subprocess
from types import SimpleNamespace

import pytest
from custom_components.flode.git_api import git_action, git_history, git_status
from custom_components.flode.git_source import GitError, GitRepository
from homeassistant.exceptions import Unauthorized


def git(path, *args):
    return subprocess.run(
        ["git", "-c", "user.name=FLODE Test", "-c", "user.email=test@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        cwd=path, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        check=True, capture_output=True, text=True,
    ).stdout.strip()


@pytest.fixture
def checkout(tmp_path):
    remote = tmp_path / "remote.git"
    writer = tmp_path / "writer"
    local = tmp_path / "checkout"
    git(tmp_path, "init", "--bare", "--initial-branch=main", str(remote))
    git(tmp_path, "init", "--initial-branch=main", str(writer))
    (writer / "automations").mkdir()
    (writer / "automations" / "test.yaml").write_text("- id: test\n  alias: First\n")
    git(writer, "add", ".")
    git(writer, "commit", "-m", "Initial configuration")
    (writer / "README.md").write_text("Test configuration")
    git(writer, "add", ".")
    git(writer, "commit", "-m", "Document configuration")
    git(writer, "remote", "add", "origin", str(remote))
    git(writer, "push", "origin", "main")
    git(tmp_path, "clone", str(remote), str(local))
    return GitRepository(str(local)), writer, remote


def publish(writer):
    (writer / "automations" / "test.yaml").write_text("- id: test\n  alias: Updated\n")
    git(writer, "add", ".")
    git(writer, "commit", "-m", "Update automation")
    git(writer, "push", "origin", "main")


def test_fetch_downloads_history_without_changing_files_then_pull_updates_main(checkout):
    repo, writer, _ = checkout
    before = repo.request("status")
    content = (repo.root / "automations" / "test.yaml").read_bytes()
    publish(writer)
    fetched = repo.request("fetch")
    assert fetched["commit"] == before["commit"]
    assert fetched["behind"] == 1
    assert (repo.root / "automations" / "test.yaml").read_bytes() == content
    assert repo.request("history")["commits"][0]["subject"] == "Update automation"
    pulled = repo.request("pull", expected_head=before["commit"])
    assert pulled["commit"] == fetched["remote"]
    assert pulled["branch"] == "main"
    assert pulled["behind"] == 0
    assert "Updated" in (repo.root / "automations" / "test.yaml").read_text()


def test_history_checkout_preserves_main_and_can_return(checkout):
    repo, _, _ = checkout
    before = repo.request("status")
    old = repo.request("history")["commits"][-1]["commit"]
    historical = repo.request("checkout", expected_head=before["commit"], revision=old)
    assert historical["branch"] is None
    assert historical["commit"] == old
    assert historical["main"] == before["main"]
    assert not (repo.root / "README.md").exists()
    restored = repo.request("main", expected_head=old)
    assert restored["branch"] == "main"
    assert restored["commit"] == before["commit"]


@pytest.mark.parametrize("untracked", [False, True])
def test_local_changes_are_never_discarded_and_fetch_is_still_allowed(checkout, untracked):
    repo, _, _ = checkout
    before = repo.request("status")
    file = repo.root / ("new.yaml" if untracked else "automations/test.yaml")
    file.write_text("local changes")
    for action in ["pull", "main", "checkout"]:
        with pytest.raises(GitError, match="Local changes"):
            repo.request(action, expected_head=before["commit"], revision=before["commit"])
    assert repo.request("fetch")["dirty"]
    assert file.read_text() == "local changes"


def test_divergence_refuses_merge_without_modifying_local_main(checkout):
    repo, writer, _ = checkout
    (repo.root / "local.md").write_text("local commit")
    git(repo.root, "add", ".")
    git(repo.root, "commit", "-m", "Local change")
    before = repo.request("status")
    publish(writer)
    with pytest.raises(GitError):
        repo.request("pull", expected_head=before["commit"])
    status = repo.request("status")
    assert status["commit"] == before["commit"]
    assert (status["ahead"], status["behind"]) == (1, 1)
    assert not status["dirty"]


def test_stale_requests_cannot_switch_a_newer_checkout(checkout):
    repo, _, _ = checkout
    old = repo.request("history")["commits"][-1]["commit"]
    with pytest.raises(GitError, match="checkout changed"):
        repo.request("checkout", expected_head=old, revision=old)


@pytest.mark.parametrize("revision", ["--force", "HEAD~1", "main", "a" * 40])
def test_checkout_accepts_only_commits_from_main_history(checkout, revision):
    repo, _, _ = checkout
    before = repo.request("status")
    with pytest.raises(GitError):
        repo.request("checkout", expected_head=before["commit"], revision=revision)
    assert repo.request("status")["commit"] == before["commit"]


def test_missing_remote_does_not_prevent_reading_current_version(checkout):
    repo, _, _ = checkout
    git(repo.root, "remote", "remove", "origin")
    assert not repo.request("status")["has_origin"]
    with pytest.raises(GitError):
        repo.request("fetch")
    assert repo.request("status")["branch"] == "main"


def test_nested_directory_is_not_silently_treated_as_another_repository(checkout):
    repo, _, _ = checkout
    with pytest.raises(GitError, match="repository root"):
        GitRepository(str(repo.root / "automations"))


def test_history_is_paginated(checkout):
    repo, _, _ = checkout
    for number in range(25):
        git(repo.root, "commit", "--allow-empty", "-m", f"History entry {number}")
    first = repo.request("history")
    second = repo.request("history", offset=25)
    assert len(first["commits"]) == 25
    assert first["has_more"]
    assert len(second["commits"]) == 2
    assert not second["has_more"]


def test_checkout_does_not_execute_repository_hooks(checkout):
    repo, _, _ = checkout
    hook = repo.root / ".git" / "hooks" / "post-checkout"
    hook.write_text("#!/bin/sh\ntouch hook-was-run\n")
    hook.chmod(0o755)
    before = repo.request("status")
    old = repo.request("history")["commits"][-1]["commit"]
    repo.request("checkout", expected_head=before["commit"], revision=old)
    assert not (repo.root / "hook-was-run").exists()


@pytest.mark.parametrize("handler", [git_status, git_history, git_action])
def test_git_commands_require_admin(handler):
    with pytest.raises(Unauthorized):
        handler(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {"id": 1})
