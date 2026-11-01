"""Git synchronization uses disposable repositories and a local bare remote."""
import os
import subprocess
from types import SimpleNamespace

import pytest
from homeassistant.exceptions import Unauthorized

from custom_components.flode.file_writer import open_automation, save_automation
from custom_components.flode.git_api import (
    git_action,
    git_changes,
    git_history,
    git_status,
)
from custom_components.flode.git_source import GitError, GitRepository


def git(path, *args):
    return subprocess.run(
        ["git", "-c", "user.name=FLODE Test", "-c", "user.email=test@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        cwd=path, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def request(repo, action, **details):
    return repo.request(action, **{'expected_directory': str(repo.root), **details})


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
    git(local, 'switch', '--create', 'prod')
    git(local, 'push', 'origin', 'prod')
    return GitRepository(str(local)), writer, remote


def publish(writer):
    (writer / "automations" / "test.yaml").write_text("- id: test\n  alias: Updated\n")
    git(writer, "add", ".")
    git(writer, "commit", "-m", "Update automation")
    git(writer, "push", "origin", "main")


def test_fetch_downloads_history_without_changing_files_then_merge_updates_prod(checkout):
    repo, writer, _ = checkout
    before = request(repo, "status")
    content = (repo.root / "automations" / "test.yaml").read_bytes()
    publish(writer)
    fetched = request(repo, "fetch")
    assert fetched["commit"] == before["commit"]
    assert fetched["incoming"] == 1
    assert (repo.root / "automations" / "test.yaml").read_bytes() == content
    assert request(repo, "history")["commits"][0]["subject"] == "Update automation"
    pulled = request(repo, "merge", expected_head=before["commit"])
    assert git(repo.root, "rev-parse", "HEAD^2") == fetched["remote_main"]
    assert pulled["branch"] == "prod"
    assert pulled["incoming"] == 0
    assert "Updated" in (repo.root / "automations" / "test.yaml").read_text()


def test_history_view_does_not_change_live_files_or_branch(checkout):
    repo, _, _ = checkout
    before = request(repo, "status")
    old = request(repo, "history")["commits"][-1]["commit"]
    content = (repo.root / "README.md").read_bytes()
    viewed = request(repo, "show", revision=old)
    assert viewed["revision"] == old
    assert "Initial configuration" in viewed["diff"]
    assert request(repo, "status") == before
    assert (repo.root / "README.md").read_bytes() == content
    with pytest.raises(GitError, match="Unsupported Git operation"):
        request(repo, "checkout", expected_head=before["commit"], revision=old)


@pytest.mark.parametrize("untracked", [False, True])
def test_local_changes_are_never_discarded_and_fetch_is_still_allowed(checkout, untracked):
    repo, _, _ = checkout
    before = request(repo, "status")
    file = repo.root / ("new.yaml" if untracked else "automations/test.yaml")
    file.write_text("local changes")
    for action in ["merge", "prod"]:
        with pytest.raises(GitError, match="Local changes"):
            request(repo, action, expected_head=before["commit"], revision=before["commit"])
    assert request(repo, "fetch")["dirty"]
    assert file.read_text() == "local changes"


def test_divergence_merges_without_rewriting_prod_or_main(checkout):
    repo, writer, remote = checkout
    (repo.root / 'local.md').write_text('local commit')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Local change')
    before = request(repo, 'status')
    original_main = git(repo.root, 'rev-parse', 'main')
    publish(writer)
    incoming = git(remote, 'rev-parse', 'main')
    merged = request(repo, 'merge', expected_head=before['commit'])
    assert git(repo.root, 'show', '-s', '--format=%P', 'HEAD').split() == [before['commit'], incoming]
    assert git(repo.root, 'rev-parse', 'main') == original_main
    assert git(remote, 'rev-parse', 'prod') == original_main
    assert (repo.root / 'local.md').read_text() == 'local commit'
    assert 'Updated' in (repo.root / 'automations/test.yaml').read_text()
    assert not merged['dirty']


def test_stale_requests_cannot_switch_a_newer_checkout(checkout):
    repo, _, _ = checkout
    old = request(repo, "history")["commits"][-1]["commit"]
    with pytest.raises(GitError, match="checkout changed"):
        request(repo, "prod", expected_head=old)


@pytest.mark.parametrize("revision", ["--force", "HEAD~1", "main", "a" * 40])
def test_checkout_accepts_only_commits_from_main_history(checkout, revision):
    repo, _, _ = checkout
    before = request(repo, "status")
    with pytest.raises(GitError):
        request(repo, "checkout", expected_head=before["commit"], revision=revision)
    assert request(repo, "status")["commit"] == before["commit"]


def test_missing_remote_does_not_prevent_reading_current_version(checkout):
    repo, _, _ = checkout
    git(repo.root, "remote", "remove", "origin")
    assert not request(repo, "status")["has_origin"]
    with pytest.raises(GitError):
        request(repo, "fetch")
    assert request(repo, "status")["branch"] == "prod"


def test_nested_directory_is_not_silently_treated_as_another_repository(checkout):
    repo, _, _ = checkout
    with pytest.raises(GitError, match="repository root"):
        GitRepository(str(repo.root / "automations"))


def test_history_is_paginated(checkout):
    repo, _, _ = checkout
    for number in range(25):
        git(repo.root, "commit", "--allow-empty", "-m", f"History entry {number}")
    first = request(repo, "history")
    second = request(repo, "history", offset=25)
    assert len(first["commits"]) == 25
    assert first["has_more"]
    assert len(second["commits"]) == 2
    assert not second["has_more"]


def test_checkout_does_not_execute_repository_hooks(checkout):
    repo, _, _ = checkout
    hook = repo.root / ".git" / "hooks" / "post-checkout"
    hook.write_text("#!/bin/sh\ntouch hook-was-run\n")
    hook.chmod(0o755)
    old = request(repo, "history")["commits"][-1]["commit"]
    request(repo, "show", revision=old)
    assert not (repo.root / "hook-was-run").exists()


@pytest.mark.parametrize("handler", [git_status, git_history, git_changes, git_action])
def test_git_commands_require_admin(handler):
    with pytest.raises(Unauthorized):
        handler(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {"id": 1})


def commit_review(repo, message="Edit configuration", **overrides):
    details = {
        "expected_head": request(repo, "status")["commit"],
        "expected_directory": str(repo.root),
        "expected_changes": request(repo, "changes")["version"],
        "message": message,
        **overrides,
    }
    return request(repo, "commit", **details)


def test_review_commit_and_push_are_separate_and_include_new_files(checkout):
    repo, _, remote = checkout
    path = repo.root / "automations/test.yaml"
    path.write_text("- id: test\n  alias: Local edit\n")
    (repo.root / "tests").mkdir()
    (repo.root / "tests/test_new.py").write_text("# New test\n")
    before_remote = git(remote, "rev-parse", "prod")
    review = request(repo, "changes")
    assert set(review["files"]) == {"automations/test.yaml", "tests/test_new.py"}
    assert "Local edit" in review["diff"] and "New test" in review["diff"]
    assert not git(repo.root, "diff", "--cached", "--name-only")
    committed = commit_review(repo)
    assert not committed["dirty"]
    assert committed["ahead"] == 1
    assert git(remote, "rev-parse", "prod") == before_remote
    pushed = request(repo, "push", expected_head=committed["commit"], expected_directory=str(repo.root))
    assert pushed["ahead"] == pushed["behind"] == 0
    assert git(remote, "rev-parse", "prod") == committed["commit"]


@pytest.mark.parametrize("kind", ["tracked", "untracked", "staged"])
def test_commit_refuses_a_stale_review(checkout, kind):
    repo, _, _ = checkout
    path = repo.root / "automations/test.yaml"
    path.write_text("changed before review\n")
    reviewed = request(repo, "changes")["version"]
    if kind == "tracked":
        path.write_text("changed after review\n")
    elif kind == "untracked":
        (repo.root / "new.txt").write_text("new after review\n")
    else:
        git(repo.root, "add", ".")
    head = request(repo, "status")["commit"]
    with pytest.raises(GitError, match="review changes again"):
        commit_review(repo, expected_changes=reviewed)
    assert request(repo, "status")["commit"] == head


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
        request(repo, "push", expected_head=request(repo, "status")["commit"], expected_directory="/other-project")


def test_push_prod_does_not_publish_into_main_or_require_main_merge(checkout):
    repo, writer, remote = checkout
    (repo.root / 'README.md').write_text('local change')
    committed = commit_review(repo)
    publish(writer)
    main_head = git(remote, 'rev-parse', 'main')
    pushed = request(repo, 'push', expected_head=committed['commit'])
    assert git(remote, 'rev-parse', 'main') == main_head
    assert git(remote, 'rev-parse', 'prod') == committed['commit']
    assert pushed['incoming'] == 1


def test_push_and_merge_reject_external_prod_changes(checkout):
    repo, writer, remote = checkout
    git(writer, 'fetch', 'origin', 'prod')
    git(writer, 'switch', '--create', 'prod', 'origin/prod')
    (writer / 'external.md').write_text('unexpected writer')
    git(writer, 'add', '.')
    git(writer, 'commit', '-m', 'External prod write')
    git(writer, 'push', 'origin', 'prod')
    remote_head = git(remote, 'rev-parse', 'prod')
    before = request(repo, 'status')
    for action in ('push', 'merge'):
        with pytest.raises(GitError, match='another writer'):
            request(repo, action, expected_head=before['commit'])
    assert git(remote, 'rev-parse', 'prod') == remote_head
    assert request(repo, 'status')['commit'] == before['commit']


def test_push_does_not_include_uncommitted_files(checkout):
    repo, _, remote = checkout
    (repo.root / "README.md").write_text("committed")
    committed = commit_review(repo)
    (repo.root / "README.md").write_text("not committed")
    request(repo, "push", expected_head=committed["commit"], expected_directory=str(repo.root))
    assert git(remote, "show", "prod:README.md") == "committed"
    assert (repo.root / "README.md").read_text() == "not committed"


def test_detached_checkout_cannot_commit_or_push(checkout):
    repo, _, _ = checkout
    head = request(repo, "status")["commit"]
    git(repo.root, "switch", "--detach", head)
    for action in ("commit", "push"):
        with pytest.raises(GitError, match="Return to prod"):
            request(repo, action, expected_head=head, expected_directory=str(repo.root))


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


def test_large_snapshots_are_committed_completely_with_a_bounded_preview(checkout):
    repo, _, _ = checkout
    content = 'x' * 70000
    (repo.root / "README.md").write_text(content)
    review = request(repo, "changes")
    assert review["truncated"]
    assert len(review["diff"].encode()) <= 64 * 1024
    committed = commit_review(repo)
    assert not committed['dirty']
    assert git(repo.root, 'show', 'HEAD:README.md') == content


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
    git(repo.root, 'push', 'origin', 'prod')
    before_head = git(repo.root, 'rev-parse', 'HEAD')
    before_files = snapshot_project_files(repo.root)
    before_tree = tree_entries(repo.root, 'HEAD')
    selected = 'automations/climate/heating.yaml'
    snapshot = open_automation(str(repo.root), selected, 'first')
    save_automation(str(repo.root), selected, 'first', snapshot['version'], str(repo.root),
                    {**snapshot['config'], 'alias': 'One changed file'})
    assert request(repo, 'changes')['files'] == [selected]
    committed = commit_review(repo)
    assert git(repo.root, 'diff', '--name-only', before_head, committed['commit']) == selected
    after_files = snapshot_project_files(repo.root)
    assert after_files.keys() == before_files.keys()
    assert {file for file in before_files if before_files[file] != after_files[file]} == {selected}
    request(repo, 'push', expected_head=committed['commit'], expected_directory=str(repo.root))
    assert git(remote, 'diff', '--name-only', before_head, 'prod') == selected
    after_tree = tree_entries(remote, 'prod')
    assert after_tree.keys() == before_tree.keys()
    assert {file for file in before_tree if before_tree[file] != after_tree[file]} == {selected}
    assert snapshot_project_files(repo.root) == after_files, 'Push rewrote working files'


def test_checkout_requires_prod_without_legacy_main_fallback(checkout):
    repo, _, _ = checkout
    git(repo.root, 'switch', 'main')
    git(repo.root, 'branch', '-d', 'prod')
    with pytest.raises(GitError, match='existing prod branch'):
        GitRepository(str(repo.root))


def test_main_and_other_branches_cannot_be_modified_through_ha(checkout):
    repo, _, _ = checkout
    git(repo.root, 'switch', 'main')
    before = git(repo.root, 'rev-parse', 'HEAD')
    for action in ('commit', 'push', 'merge', 'revert', 'prod'):
        with pytest.raises(GitError, match='Only prod'):
            request(repo, action, expected_head=before)
    assert git(repo.root, 'rev-parse', 'HEAD') == before


def test_fast_forward_eligible_update_still_has_a_reversible_merge_commit(checkout):
    repo, writer, remote = checkout
    before = request(repo, 'status')
    before_tree = tree_entries(repo.root, 'HEAD')
    publish(writer)
    main = git(remote, 'rev-parse', 'main')
    merged = request(repo, 'merge', expected_head=before['commit'])
    assert merged['merge_to_revert'] == merged['commit']
    assert git(repo.root, 'show', '-s', '--format=%P', 'HEAD').split() == [before['commit'], main]
    assert git(remote, 'rev-parse', 'prod') == before['commit']
    request(repo, 'push', expected_head=merged['commit'])
    undone = request(repo, 'revert', expected_head=merged['commit'], revision=merged['commit'])
    assert tree_entries(repo.root, 'HEAD') == before_tree
    assert undone['merge_to_revert'] is None
    assert git(repo.root, 'rev-parse', 'HEAD^') == merged['commit']
    assert git(remote, 'rev-parse', 'prod') == merged['commit']
    request(repo, 'push', expected_head=undone['commit'])
    assert git(remote, 'rev-parse', 'prod') == undone['commit']
    assert git(remote, 'rev-parse', 'main') == main
    # A revert preserves merge ancestry; merging the same main does not reapply it.
    repeated = request(repo, 'merge', expected_head=undone['commit'])
    assert repeated['commit'] == undone['commit']
    assert tree_entries(repo.root, 'HEAD') == before_tree


def test_conflicting_merge_aborts_and_human_resolution_in_main_can_be_merged(checkout):
    repo, writer, remote = checkout
    path = repo.root / 'automations/test.yaml'
    path.write_text('- id: test\n  alias: HA edit\n')
    local = commit_review(repo)
    request(repo, 'push', expected_head=local['commit'])
    before_tree = tree_entries(repo.root, 'HEAD')
    publish(writer)
    with pytest.raises(GitError, match='previous prod was restored'):
        request(repo, 'merge', expected_head=local['commit'])
    assert request(repo, 'status')['commit'] == local['commit']
    assert not request(repo, 'status')['dirty']
    assert path.read_text() == '- id: test\n  alias: HA edit\n'
    assert tree_entries(repo.root, 'HEAD') == before_tree
    assert not (repo.root / '.git/MERGE_HEAD').exists()
    assert git(remote, 'rev-parse', 'prod') == local['commit']
    # On the computer, merge prod into main, resolve, and publish main only.
    git(writer, 'fetch', 'origin', 'prod')
    with pytest.raises(subprocess.CalledProcessError):
        git(writer, 'merge', '--no-ff', 'origin/prod')
    (writer / 'automations/test.yaml').write_text('- id: test\n  alias: Resolved on computer\n')
    git(writer, 'add', '.')
    git(writer, 'commit', '-m', 'Resolve prod and main on computer')
    git(writer, 'push', 'origin', 'main')
    resolved = git(remote, 'rev-parse', 'main')
    merged = request(repo, 'merge', expected_head=local['commit'])
    assert path.read_text() == '- id: test\n  alias: Resolved on computer\n'
    assert git(repo.root, 'show', '-s', '--format=%P', 'HEAD').split() == [local['commit'], resolved]
    assert merged['merge_to_revert'] == merged['commit']
    assert not merged['dirty']


def test_revert_is_limited_to_latest_owned_merge_and_refuses_later_work(checkout):
    repo, writer, _ = checkout
    publish(writer)
    merged = request(repo, 'merge', expected_head=request(repo, 'status')['commit'])
    (repo.root / 'README.md').write_text('Later local work')
    with pytest.raises(GitError, match='Local changes'):
        request(repo, 'revert', expected_head=merged['commit'], revision=merged['commit'])
    committed = commit_review(repo)
    assert committed['merge_to_revert'] is None
    with pytest.raises(GitError, match='latest FLODE main merge'):
        request(repo, 'revert', expected_head=committed['commit'], revision=merged['commit'])
    assert (repo.root / 'README.md').read_text() == 'Later local work'


def test_merge_and_revert_use_configured_identity_without_hooks_or_signing(checkout, monkeypatch):
    repo, writer, _ = checkout
    for hook_name in ('pre-merge-commit', 'post-merge', 'pre-commit'):
        hook = repo.root / '.git/hooks' / hook_name
        hook.write_text('#!/bin/sh\ntouch hook-was-run\nexit 1\n')
        hook.chmod(0o755)
    git(repo.root, 'config', 'commit.gpgsign', 'true')
    monkeypatch.setenv('GIT_AUTHOR_NAME', 'Server identity')
    monkeypatch.setenv('GIT_AUTHOR_EMAIL', 'server@example.invalid')
    monkeypatch.setenv('GIT_COMMITTER_NAME', 'Server identity')
    monkeypatch.setenv('GIT_COMMITTER_EMAIL', 'server@example.invalid')
    publish(writer)
    merged = request(repo, 'merge', expected_head=request(repo, 'status')['commit'])
    assert git(repo.root, 'log', '-1', '--format=%an <%ae> / %cn <%ce>') == 'FLODE Test <test@example.invalid> / FLODE Test <test@example.invalid>'
    request(repo, 'revert', expected_head=merged['commit'], revision=merged['commit'])
    assert git(repo.root, 'log', '-1', '--format=%an <%ae> / %cn <%ce>') == 'FLODE Test <test@example.invalid> / FLODE Test <test@example.invalid>'
    assert not (repo.root / 'hook-was-run').exists()


@pytest.mark.parametrize('action', ['fetch', 'merge', 'prod', 'revert'])
def test_all_git_actions_reject_a_changed_project_root(checkout, action):
    repo, _, _ = checkout
    before = request(repo, 'status')['commit']
    with pytest.raises(GitError, match='project changed'):
        request(repo, action, expected_head=before, expected_directory='/different-project')
    assert request(repo, 'status')['commit'] == before


def test_merge_needs_no_identity_when_already_up_to_date_but_validates_before_new_merge(checkout):
    repo, writer, _ = checkout
    git(repo.root, 'config', 'user.email', '')
    before = request(repo, 'status')['commit']
    assert request(repo, 'merge', expected_head=before)['commit'] == before
    publish(writer)
    with pytest.raises(GitError, match='Configure user.name'):
        request(repo, 'merge', expected_head=before)
    assert request(repo, 'status')['commit'] == before
    assert not request(repo, 'status')['dirty']


def test_preexisting_merge_is_never_aborted_by_another_request(checkout):
    repo, writer, _ = checkout
    (repo.root / 'automations/test.yaml').write_text('- id: test\n  alias: Local\n')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Local edit')
    publish(writer)
    request(repo, 'fetch')
    with pytest.raises(subprocess.CalledProcessError):
        git(repo.root, 'merge', 'origin/main')
    conflict = (repo.root / 'automations/test.yaml').read_bytes()
    before = request(repo, 'status')['commit']
    with pytest.raises(GitError, match='operation is in progress'):
        request(repo, 'merge', expected_head=before)
    assert (repo.root / '.git/MERGE_HEAD').exists()
    assert (repo.root / 'automations/test.yaml').read_bytes() == conflict



def test_local_main_branch_is_not_required(checkout):
    repo, writer, _ = checkout
    git(repo.root, 'branch', '-d', 'main')
    repository = GitRepository(str(repo.root))
    publish(writer)
    merged = request(repository, 'merge', expected_head=request(repository, 'status')['commit'])
    assert merged['branch'] == 'prod' and merged['incoming'] == 0



def test_historical_files_cannot_be_saved_or_replaced_by_object_export(checkout):
    from custom_components.flode.object_source import export_catalog
    repo, _, _ = checkout
    snapshot = open_automation(str(repo.root), 'automations/test.yaml', 'test')
    head = request(repo, 'status')['commit']
    git(repo.root, "switch", "--detach", head)
    with pytest.raises(GitError, match='historical revisions are read-only'):
        save_automation(str(repo.root), 'automations/test.yaml', 'test', snapshot['version'], str(repo.root),
                        {**snapshot['config'], 'alias': 'Forbidden historical edit'})
    with pytest.raises(GitError, match='historical revisions are read-only'):
        export_catalog(str(repo.root), str(repo.root), {})
    assert not request(repo, 'status')['dirty']
    request(repo, 'prod', expected_head=head)
    assert request(repo, 'status')['branch'] == 'prod'


@pytest.mark.parametrize("action", ["prod", "merge"])
def test_unrelated_ignored_files_do_not_block_git_operations(checkout, action):
    repo, _, _ = checkout
    (repo.root / '.gitignore').write_text('.env\n.venv/\n')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Ignore local environment')
    (repo.root / '.env').write_text('local private content')
    (repo.root / '.venv').mkdir()
    (repo.root / '.venv/cache').write_text('local cache')
    before = request(repo, 'status')['commit']
    request(repo, action, expected_head=before)
    assert (repo.root / '.env').read_text() == 'local private content'
    assert (repo.root / '.venv/cache').read_text() == 'local cache'


@pytest.mark.parametrize('kind', ['tracked', 'untracked'])
def test_external_write_after_snapshot_is_preserved_and_never_committed(checkout, monkeypatch, kind):
    repo, _, _ = checkout
    path = repo.root / ('README.md' if kind == 'tracked' else 'new.txt')
    path.write_text('reviewed content')
    original = repo._git
    def raced(*args, **kwargs):
        result = original(*args, **kwargs)
        if 'commit-tree' in args:
            path.write_text('external write after snapshot')
        return result
    monkeypatch.setattr(repo, '_git', raced)
    committed = commit_review(repo)
    assert git(repo.root, 'show', 'HEAD:' + path.name) == 'reviewed content'
    assert path.read_text() == 'external write after snapshot'
    assert committed['dirty']


def test_external_write_during_snapshot_rejects_review_and_preserves_index(checkout, monkeypatch):
    repo, _, _ = checkout
    path = repo.root / 'README.md'
    path.write_text('reviewed content')
    review = request(repo, 'changes')['version']
    original = repo._git
    def raced(*args, **kwargs):
        if args[:2] == ('add', '--all'):
            path.write_text('external write before staging')
        return original(*args, **kwargs)
    monkeypatch.setattr(repo, '_git', raced)
    before = git(repo.root, 'rev-parse', 'HEAD')
    with pytest.raises(GitError, match='review changes again'):
        commit_review(repo, expected_changes=review)
    assert git(repo.root, 'rev-parse', 'HEAD') == before
    assert not git(repo.root, 'diff', '--cached', '--name-only')
    assert path.read_text() == 'external write before staging'


def test_differing_push_destination_is_rejected(checkout, tmp_path):
    repo, _, _ = checkout
    git(repo.root, 'remote', 'set-url', '--push', 'origin', str(tmp_path / 'other.git'))
    with pytest.raises(GitError, match='identical fetch and push'):
        request(repo, 'push', expected_head=request(repo, 'status')['commit'])


def test_push_timeout_is_reconciled_with_actual_remote(checkout, monkeypatch):
    repo, _, remote = checkout
    (repo.root / 'README.md').write_text('publish this')
    committed = commit_review(repo)
    original = repo._git
    def timed_out(*args, **kwargs):
        result = original(*args, **kwargs)
        if 'push' in args:
            raise GitError('Git timed out')
        return result
    monkeypatch.setattr(repo, '_git', timed_out)
    result = request(repo, 'push', expected_head=committed['commit'])
    assert result['remote_prod'] == git(remote, 'rev-parse', 'prod') == committed['commit']


@pytest.mark.parametrize('branch', ['main', 'detached'])
def test_nested_project_cannot_bypass_save_and_export_guards(checkout, branch):
    from custom_components.flode.object_source import export_catalog
    repo, _, _ = checkout
    nested = repo.root / 'nested'
    (nested / 'automations').mkdir(parents=True)
    (nested / 'automations/test.yaml').write_text('- id: nested\n  alias: Nested\n')
    if branch == 'detached':
        git(repo.root, 'switch', '--detach', 'HEAD')
    else:
        git(repo.root, 'switch', 'main')
    snapshot = open_automation(str(nested), 'automations/test.yaml', 'nested')
    with pytest.raises(GitError, match='repository root'):
        save_automation(str(nested), 'automations/test.yaml', 'nested', snapshot['version'], str(nested),
                        {**snapshot['config'], 'alias': 'Forbidden'})
    with pytest.raises(GitError, match='repository root'):
        export_catalog(str(nested), str(nested), {})


def test_return_to_prod_preserves_ignored_recreated_historical_file(checkout):
    repo, _, _ = checkout
    private = repo.root / 'private.yaml'
    private.write_text('tracked prod content')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Track configuration')
    prod = git(repo.root, 'rev-parse', 'HEAD')
    git(repo.root, 'switch', '--detach', prod)
    git(repo.root, 'rm', 'private.yaml')
    (repo.root / '.gitignore').write_text('private.yaml\n')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Historical ignored configuration')
    private.write_text('local secret must survive')
    detached = git(repo.root, 'rev-parse', 'HEAD')
    with pytest.raises(GitError, match='Local changes'):
        request(repo, 'prod', expected_head=detached)
    assert private.read_text() == 'local secret must survive'
    assert git(repo.root, 'rev-parse', 'HEAD') == detached


def test_merge_preserves_ignored_file_introduced_by_main(checkout):
    repo, writer, _ = checkout
    (repo.root / '.gitignore').write_text('private.yaml\n')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Ignore private configuration')
    (repo.root / 'private.yaml').write_text('local secret must survive')
    (writer / 'private.yaml').write_text('incoming tracked content')
    git(writer, 'add', '.')
    git(writer, 'commit', '-m', 'Introduce conflicting configuration')
    git(writer, 'push', 'origin', 'main')
    before = git(repo.root, 'rev-parse', 'HEAD')
    with pytest.raises(GitError, match='Local changes'):
        request(repo, 'merge', expected_head=before)
    assert (repo.root / 'private.yaml').read_text() == 'local secret must survive'
    assert git(repo.root, 'rev-parse', 'HEAD') == before


@pytest.mark.parametrize('stderr', ['fatal: detected dubious ownership in repository', 'fatal: Permission denied'])
def test_git_detection_errors_fail_closed(tmp_path, monkeypatch, stderr):
    from custom_components.flode.git_source import require_prod_for_writes
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=128, stderr=stderr))
    with pytest.raises(GitError, match='file changes are blocked'):
        require_prod_for_writes(tmp_path)


def test_invalid_git_marker_never_disables_write_guard(tmp_path):
    from custom_components.flode.git_source import require_prod_for_writes
    (tmp_path / '.git').mkdir()
    with pytest.raises(GitError, match='file changes are blocked'):
        require_prod_for_writes(tmp_path)


def test_non_git_project_can_still_be_written(tmp_path):
    from custom_components.flode.git_source import require_prod_for_writes
    require_prod_for_writes(tmp_path)



def test_history_merge_view_shows_deployed_changes_against_previous_prod(checkout):
    repo, writer, _ = checkout
    before = request(repo, 'status')['commit']
    publish(writer)
    merged = request(repo, 'merge', expected_head=before)
    viewed = request(repo, 'show', revision=merged['commit'])
    assert '-  alias: First' in viewed['diff']
    assert '+  alias: Updated' in viewed['diff']
    assert request(repo, 'status')['commit'] == merged['commit']



def test_ignored_collision_check_preserves_leading_whitespace_in_paths(checkout):
    repo, _, _ = checkout
    private = repo.root / ' private.yaml'
    private.write_text('tracked prod content')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Track whitespace configuration path')
    prod = git(repo.root, 'rev-parse', 'HEAD')
    git(repo.root, 'switch', '--detach', prod)
    git(repo.root, 'rm', ' private.yaml')
    (repo.root / '.gitignore').write_text(' private.yaml\n')
    git(repo.root, 'add', '.')
    git(repo.root, 'commit', '-m', 'Ignore whitespace configuration path')
    private.write_text('local secret must survive')
    with pytest.raises(GitError, match='ignored files'):
        repo._protect_ignored('refs/heads/prod')
    assert private.read_text() == 'local secret must survive'
