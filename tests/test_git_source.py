"""Git synchronization uses disposable repositories and a local bare remote."""
import os
import subprocess
from types import SimpleNamespace

import pytest
from custom_components.flode.file_writer import open_automation, save_automation
from custom_components.flode.git_api import (
    git_action,
    git_changes,
    git_history,
    git_status,
)
from custom_components.flode.git_source import GitError, GitRepository
from homeassistant.exceptions import Unauthorized


def git(path, *args):
    return subprocess.run(
        ["git", "-c", "user.name=FLODE Test", "-c", "user.email=test@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        cwd=path, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def tree_entries(path, revision):
    result = {}
    for line in git(path, 'ls-tree', '-r', revision).splitlines():
        metadata, file = line.split('\t', 1)
        result[file] = metadata
    return result


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
    git(local, 'config', 'user.name', 'FLODE Test')
    git(local, 'config', 'user.email', 'test@example.invalid')
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


@pytest.mark.parametrize("handler", [git_status, git_history, git_changes, git_action])
def test_git_commands_require_admin(handler):
    with pytest.raises(Unauthorized):
        handler(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {"id": 1})


def commit_review(repo, message="Edit configuration", **overrides):
    details = {
        "expected_head": repo.request("status")["commit"],
        "expected_directory": str(repo.root),
        "expected_changes": repo.request("changes")["version"],
        "message": message,
        **overrides,
    }
    return repo.request("commit", **details)


def test_review_commit_and_push_are_separate_and_include_new_files(checkout):
    repo, _, remote = checkout
    path = repo.root / "automations/test.yaml"
    path.write_text("- id: test\n  alias: Local edit\n")
    (repo.root / "tests").mkdir()
    (repo.root / "tests/test_new.py").write_text("# New test\n")
    before_remote = git(remote, "rev-parse", "main")
    review = repo.request("changes")
    assert set(review["files"]) == {"automations/test.yaml", "tests/test_new.py"}
    assert "Local edit" in review["diff"] and "New test" in review["diff"]
    assert not git(repo.root, "diff", "--cached", "--name-only")
    committed = commit_review(repo)
    assert not committed["dirty"]
    assert committed["ahead"] == 1
    assert git(remote, "rev-parse", "main") == before_remote
    pushed = repo.request("push", expected_head=committed["commit"], expected_directory=str(repo.root))
    assert pushed["ahead"] == pushed["behind"] == 0
    assert git(remote, "rev-parse", "main") == committed["commit"]


@pytest.mark.parametrize("kind", ["tracked", "untracked", "staged"])
def test_commit_refuses_a_stale_review(checkout, kind):
    repo, _, _ = checkout
    path = repo.root / "automations/test.yaml"
    path.write_text("changed before review\n")
    reviewed = repo.request("changes")["version"]
    if kind == "tracked":
        path.write_text("changed after review\n")
    elif kind == "untracked":
        (repo.root / "new.txt").write_text("new after review\n")
    else:
        git(repo.root, "add", ".")
    head = repo.request("status")["commit"]
    with pytest.raises(GitError, match="review changes again"):
        commit_review(repo, expected_changes=reviewed)
    assert repo.request("status")["commit"] == head


@pytest.mark.parametrize("missing", ["message", "name", "email"])
def test_commit_validates_message_and_configured_identity_before_staging(checkout, missing):
    repo, _, _ = checkout
    (repo.root / "README.md").write_text("changed")
    if missing == 'name':
        git(repo.root, 'config', 'user.name', '')
    elif missing == 'email':
        git(repo.root, 'config', 'user.email', '')
    with pytest.raises(GitError, match="Enter|Configure user.name"):
        commit_review(repo, message=' ' if missing == 'message' else 'Valid message')
    assert not git(repo.root, "diff", "--cached", "--name-only")


def test_commit_and_push_refuse_a_different_configured_root(checkout):
    repo, _, _ = checkout
    with pytest.raises(GitError, match="project changed"):
        commit_review(repo, expected_directory="/other-project")
    with pytest.raises(GitError, match="project changed"):
        repo.request("push", expected_head=repo.request("status")["commit"], expected_directory="/other-project")


def test_push_never_overwrites_new_remote_commits(checkout):
    repo, writer, remote = checkout
    (repo.root / "README.md").write_text("local change")
    committed = commit_review(repo)
    publish(writer)
    remote_head = git(remote, "rev-parse", "main")
    with pytest.raises(GitError, match="missing locally"):
        repo.request("push", expected_head=committed["commit"], expected_directory=str(repo.root))
    assert git(remote, "rev-parse", "main") == remote_head
    assert repo.request("status")["commit"] == committed["commit"]


def test_push_does_not_include_uncommitted_files(checkout):
    repo, _, remote = checkout
    (repo.root / "README.md").write_text("committed")
    committed = commit_review(repo)
    (repo.root / "README.md").write_text("not committed")
    repo.request("push", expected_head=committed["commit"], expected_directory=str(repo.root))
    assert git(remote, "show", "main:README.md") == "committed"
    assert (repo.root / "README.md").read_text() == "not committed"


def test_detached_checkout_cannot_commit_or_push(checkout):
    repo, _, _ = checkout
    head = repo.request("status")["commit"]
    repo.request("checkout", expected_head=head, revision=head)
    for action in ("commit", "push"):
        with pytest.raises(GitError, match="Return to main"):
            repo.request(action, expected_head=head, expected_directory=str(repo.root))


def test_commit_disables_hooks_and_signing(checkout):
    repo, _, _ = checkout
    hook = repo.root / ".git/hooks/pre-commit"
    hook.write_text("#!/bin/sh\ntouch hook-ran\nexit 1\n")
    hook.chmod(0o755)
    git(repo.root, "config", "commit.gpgsign", "true")
    (repo.root / "README.md").write_text("edit")
    commit_review(repo, message="Literal $(touch not-executed) commit")
    assert not (repo.root / "hook-ran").exists()
    assert not (repo.root / "not-executed").exists()


def test_oversized_review_cannot_be_committed_from_ui(checkout):
    repo, _, _ = checkout
    (repo.root / "README.md").write_text("x" * 70000)
    assert repo.request("changes")["truncated"]
    with pytest.raises(GitError, match="64 KiB"):
        commit_review(repo)


def test_configured_commit_author_overrides_server_environment(checkout, monkeypatch):
    repo, _, _ = checkout
    monkeypatch.setenv('GIT_AUTHOR_NAME', 'Unrelated server name')
    monkeypatch.setenv('GIT_AUTHOR_EMAIL', 'server@example.invalid')
    (repo.root / 'README.md').write_text('changed')
    commit_review(repo)
    assert git(repo.root, 'log', '-1', '--format=%an <%ae>') == 'FLODE Test <test@example.invalid>'


def test_save_commit_and_push_change_only_one_file(
    checkout, seed_isolation_project, snapshot_project_files,
):
    repo, _, remote = checkout
    seed_isolation_project(repo.root)
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Seed independent configuration files')
    git(repo.root, 'push', 'origin', 'main')
    before_head = git(repo.root, 'rev-parse', 'HEAD')
    before_files = snapshot_project_files(repo.root)
    before_tree = tree_entries(repo.root, 'HEAD')
    selected = 'automations/climate/heating.yaml'
    snapshot = open_automation(str(repo.root), selected, 'first')
    save_automation(str(repo.root), selected, 'first', snapshot['version'], str(repo.root),
                    {**snapshot['config'], 'alias': 'One changed file'})
    assert repo.request('changes')['files'] == [selected]
    committed = commit_review(repo)
    assert git(repo.root, 'diff', '--name-only', before_head, committed['commit']) == selected
    after_files = snapshot_project_files(repo.root)
    assert after_files.keys() == before_files.keys()
    assert {file for file in before_files if before_files[file] != after_files[file]} == {selected}
    repo.request('push', expected_head=committed['commit'], expected_directory=str(repo.root))
    assert git(remote, 'diff', '--name-only', before_head, 'main') == selected
    after_tree = tree_entries(remote, 'main')
    assert after_tree.keys() == before_tree.keys()
    assert {file for file in before_tree if before_tree[file] != after_tree[file]} == {selected}
    assert snapshot_project_files(repo.root) == after_files, 'Push rewrote working files'
