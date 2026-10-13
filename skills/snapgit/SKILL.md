---
name: snapgit
description: Use when working in a repository that uses snapgit (snapgit.json on the base branch, refs/snapgit/*, or a snapgit workflow): creating branches, sending or reviewing pull requests, or reacting to CI shame. Explains the timers and the one-button review model so an agent does not lose work or fight the tool.
---

# snapgit for coding agents

snapgit puts review on a clock. Branches disappear, pull requests have one button (reject), and a PR nobody rejects merges.
Know the rules before you touch a branch, because the tool enforces them without asking.

## The rules

1. **Branches have a timer.** Make them with `snapgit snap <branch> [--ttl 24h]`. The timer cannot be extended. When it runs
   out the branch is deleted (a copy is kept: `snapgit graveyard`, `snapgit resurrect <branch>` brings it back with a fresh timer).
   Do not try to extend, reset or work around a timer. Finish and send, or let it go.
2. **Send, do not merge.** Open a PR with `snapgit pr send -m "title\nwhy" -r origin --json`. CI runs first. If CI fails the
   PR is not sent, your branch self-destructs, and you are shamed (and flagged as an agent). Run the project's own tests
   before sending so this never happens.
3. **A reviewer opens it, then a fuse burns.** The fuse is sized to the change (10s + 0.5s per changed line, so small PRs are
   quick). Review is locked until CI has passed. The reviewer's only button is reject. Silence merges it.
4. **Nobody opened it means nothing merges.** An unopened PR is deleted at expiry, never merged. Keep PRs small so a human
   will actually open them.
5. **New commits void everything.** Pushing to a PR's branch resets the fuse, the CI validation and any approval. Do not push
   to a PR a reviewer has just opened unless you mean to restart their review.
6. **Protected paths need `snapgit pr approve`** from a reviewer as well. You cannot approve your own PR.
7. **Frozen means frozen.** If `snapgit status` says frozen, nothing merges or disappears. Do not look for a way around it.

## Workflow

```
snapgit status --json                    # what is on the clock, what is live, is it frozen
snapgit snap feat/short-name --ttl 4h    # start work (timer cannot be extended)
# ... commit small, test locally ...
snapgit pr checks <id>                   # (after sending locally) preview CI on the would-be merge
snapgit pr send -m "Title\nWhy this change" -r origin --json
snapgit pr ls --json                     # id, opened?, who opened it, when it merges
snapgit pr burn <id>                     # withdraw your own PR if you spot a mistake
snapgit undo <id> --push -r origin       # revert something snapgit merged (a revert commit)
```

Use `--json` whenever you parse output. `snapgit pr send --json` returns `{ok, id, lines, fuseMs, expiresAt, ...}`; on a CI
failure it returns `{ok:false, shamed:{...}}` and exits 1, so read the message and fix the cause on a new branch.

## Good behavior

- Make small, single-purpose PRs. The fuse and the reviewer's patience both scale with size.
- Write a title and a reason in `-m`. A reviewer has about as many seconds as the fuse allows.
- Never edit `snapgit.json` in the same PR as the change it governs: rules come from the base branch on purpose.
- Do not read other people's receipts or shame lists to target anyone. Metrics are by team and by agent-or-human only.
- If a PR was merged and is wrong, `snapgit undo`, do not force-push history.

## Reading the room

`snapgit policy` prints the effective rules (checks, fuse sizing, reviewers, protected paths). `snapgit shame --json` lists
who broke CI recently. `snapgit metrics` shows how review is going.
