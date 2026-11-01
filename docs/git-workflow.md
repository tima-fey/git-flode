# Git operations and recovery

Operational notes for git-flode. These rules concern the **automation
configuration repository**, not the git-flode application source repository.
Commands below run in the configuration checkout; computer and HA operations
are identified explicitly.

## Branch contract

- HA owns `prod`. One HA instance is its only writer. Computers and agents
  publish changes to `main`.
- Both names are fixed. HA requires an existing local `prod`, checked out before
  normal use, and a remote `origin` with `main`. A local HA `main` is unnecessary.
  First-time branch creation is covered in the [README](../README.md#prepare-your-configuration-repository).
- External changes enter HA through **Merge main into prod**, using freshly
  fetched `origin/main`. **Push prod** never publishes into main.
- Merge and undo create local commits. Publishing them and applying their files
  to HA are separate operations.

## What can block an update

There are two independent kinds of pending work: saved filesystem changes and
unsaved editor drafts. Merge and undo require both to be clear. Git can report
a clean tree while an editor has a draft. History inspection reads commit data
without changing the checkout. Returning an externally detached checkout to
prod requires clean files, including ignored paths that Git might overwrite.

Object exports also dirty the checkout. **Commit all changes** includes every
listed changed/untracked non-ignored file, including `objects/` and `tests/`.
It builds a private tree from the reviewed working-file contents and commits
that exact tree. External writes after snapshot capture remain uncommitted. The
64-KiB preview is a display limit; content beyond it is committed too. A changed
file, index, root, or HEAD invalidates the relevant review/action and requires
refreshing it.

**Push prod** publishes committed history even if working files are dirty. Those
uncommitted files and editor drafts are not included. It fetches both main and
prod first, so remote access needs read permission for main as well as read/write
permission for prod. Credentials and identity must be available to the HA
process, not just a laptop or an SSH add-on. Git runs without interactive login
prompts; commands time out after 30 seconds. Hooks and commit signing are disabled
by the app, including for merges and reverts. Origin fetch and push URLs must
match; distinct destinations are rejected. A timed-out push is reconciled with
the remote before its outcome is reported.

## Conflict: resolve on main, then retry from HA

A successful update always creates a dedicated two-parent merge, even when Git
could fast-forward: first parent is previous prod, second is fetched main.
This makes the previous production file tree unambiguous for undo.

On conflict, the app runs `merge --abort` and verifies that HEAD is unchanged and
the tree is clean. It leaves no intentional conflict-resolution session in HA.
Repeating the same merge without changing main will fail again.

1. In HA, **Push prod** before asking the computer to resolve the conflict.
   Otherwise `origin/prod` may lack local HA commits that need reconciling.
2. On the computer, synchronize main with its remote. If main has diverged,
   reconcile that locally before continuing:

   ```sh
   git fetch origin
   git switch main
   git merge --ff-only origin/main
   ```

3. Still on computer main, merge the published HA history:

   ```sh
   git merge origin/prod
   ```

   If it stops for conflicts, edit the affected files, stage the resolutions,
   and finish the merge commit. Test the resolved configuration, then publish
   **main only**:

   ```sh
   git push origin main
   ```

4. In HA, retry **Merge main into prod**. The resolved main now contains the
   published prod history. Publish the resulting HA merge with **Push prod**.

Further computer edits should incorporate prod regularly. Otherwise changes
made in HA accumulate separately and the next deployment may conflict again.

## Undo is a revert, not a history rewind

**Undo latest main merge** creates `git revert -m 1 <merge>` on prod. Its file
tree matches the state before that merge, while the merge and its ancestry stay
in history. It works before or after publishing the merge; push the new revert
separately. No force push is required.

The shortcut is available only for the latest FLODE-created main merge at the
tip of active prod, with clean files and no drafts. It is unavailable after a
later local commit, after an earlier undo, on a detached checkout, or for an
ordinary/manual merge. This prevents dropping later local work. Older updates
need a deliberate corrective change prepared on main.

### Reapply an update that was undone

Merging the same main again is a no-op: Git remembers that its commits were
already merged. The incoming-main count can be zero while their effects have
been reverted in prod.

First publish the HA undo commit, called `R` here. On the computer, start from
synchronized main, merge prod (including `R`), and then revert **R on main**:

```sh
git fetch origin
git switch main
git merge --ff-only origin/main
git merge origin/prod
# Finish any merge conflicts before continuing.
git revert R
# Finish any revert conflicts before publishing.
git push origin main
```

Replace `R` with the undo commit's full hash, not the original merge hash.
`R` is a normal one-parent revert commit, so this command has no `-m 1`.
Then merge main into prod from HA and push prod. Nobody on the computer writes
prod, and intervening changes can be reconciled on main.

## Unexpected remote prod changes

The app permits a normal push only when fetched origin/prod is an ancestor of
local prod (or the remote branch is absent). Remote prod being ahead or diverged
blocks both push and main merge. This can indicate another writer, an older HA
checkout restored from backup, or rewritten remote history. Main containing the
desired resolution does not bypass this guard automatically.

Pause normal operations and preserve unpublished HA commits before repairing:

1. Record local prod and origin/prod hashes. Preserve HA's local prod in a uniquely
   named recovery ref; publish that recovery ref from HA if the computer needs
   otherwise-unavailable commits. Keep the production branch untouched remotely.
2. On computer main, merge both origin/prod and the preserved HA history, resolve,
   test, and publish main. Keep both histories as ancestors; copying file contents
   alone does not satisfy the ancestry check.
3. On HA's clean active prod, fetch and perform an explicit manual merge of the
   resolved origin/main. This recovery step is outside the UI because its guard
   is still blocking. Resolve any remaining conflict before proceeding.
4. Verify origin/prod is now an ancestor of HA prod, then use a normal **Push prod**.
   A manual recovery merge is not eligible for the UI's latest-merge undo shortcut.

Do not repair this by force-pushing over unknown prod commits or resetting away
unpublished HA commits. Useful diagnostics after fetching, in the HA checkout:

```sh
git log --left-right --oneline prod...origin/prod
git log --graph --oneline --decorate -30 prod origin/main origin/prod
```

## Interrupted operations and historical viewing

If a failed merge reports that automatic abort also failed, inspect `git status`
in HA before further actions. For this failed app-owned merge, `git merge --abort`
can finish recovery once the underlying filesystem/Git problem is addressed.
Use `git revert --abort` for an interrupted revert. The app refuses to touch an
operation already in progress when its request starts; it will not abort somebody
else's session. An existing lock may belong to a running Git process, so establish
that process's state before attempting lock-file cleanup.

History viewing uses `git show` to display a read-only commit diff. It never
checks out historical files or changes the live HA configuration. If an external
operator detached HEAD, **Return to prod** restores prod after clean-file checks.
Quick reload requires prod and holds the shared project lock until HA finishes
its reload, so panel Git changes cannot race that read. External Git processes
and filesystem writers do not participate in this process-local lock.

Git state and running HA state are independent. Undoing a published merge does
not undo a previous HA reload. After choosing the intended prod revision, use
the separate config check, project tests, and Quick reload as appropriate.
