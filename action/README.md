# snapgit as a GitHub Action

The same rules as the CLI, on real GitHub PRs, with nothing to host. State lives in one bot comment per PR.

## Install

Copy [`examples/snapgit.yml`](examples/snapgit.yml) to `.github/workflows/snapgit.yml` on your default branch, and
(optionally) add a `snapgit.json` to it (see the main README). Name every job `snapgit...`: snapgit ignores check runs
whose name starts with `snapgit` so it never waits on itself.

PRs opened after the workflow lands go on the clock. Older PRs are left alone until you add the `snapgit` label.

## Piloting it safely

Start with `opt-in: label` on the first step (and the wait job). Nothing changes for anyone until a PR is labelled `snapgit`,
so you can try it on one PR, then one team, then everyone. Pin the action to a commit SHA (`uses: Tiobold/snapgit@<sha>`)
rather than `@master` if your organization restricts third-party actions, and add the repository to its allowed actions list.

## How a PR moves

| What happens | Result |
|---|---|
| PR opened | A status comment: size, the **fuse** (10s + 0.5s per line, ignoring lockfiles etc.), and when it dies unopened (`ttlHours`, default 24). **Review is locked until CI has run and passed** |
| CI finishes | Green: the bot says it is ready for review. Red: the authors are shamed and the branch destroyed *immediately*, before anyone looks. (A `check_suite`/`status` event triggers this at once; the 5-minute sweep is the backup) |
| A reviewer comments `/snapgit open`, or submits a review | Refused with a reason while CI is pending/failing. Otherwise the fuse is lit (never by the PR's author). The workflow's wait job sleeps until it burns out |
| A reviewer comments `/snapgit reject [reason]`, or requests changes | Closed, labelled `snapgit:rejected` |
| Fuse burns out, CI green or absent | Merged (`mergeMethod`), branch deleted, labelled `snapgit:merged` |
| Fuse burns out, CI red | The authors are shamed (agents flagged), PR closed, branch deleted, `snapgit:shamed` |
| CI still running | Held until it finishes (said once) |
| Nobody ever opened it | Closed and deleted at expiry, `snapgit:expired`. **Nothing merges on a timer alone** |
| New commits after opening | The fuse, CI validation and any approval are voided; a reviewer must look again. The merge is also pinned to the reviewed commit (`sha`), so a push that raced the event cannot merge unreviewed code |
| Touches `protectedPaths` | Also needs a reviewer's `/snapgit approve`; unapproved at expiry it is deleted |
| `/snapgit undo` (reviewers) | GitHub's own revert, as a new PR that goes through snapgit like any other |
| `frozen: true` in `snapgit.json` | Nothing merges or disappears |

Reviewers come from `snapgit.json` (`"@alice"` logins) or `"reviewers": "CODEOWNERS"` (individual owners; teams can't be
resolved). With no reviewers configured, any repository **member, owner or collaborator** other than the author can act (a
throwaway account cannot). Authors can reject (withdraw) their own PRs. snapgit never deletes the default or base branch, buries a
copy of every branch tip it deletes (`refs/snapgit/graveyard/*`), and a frozen repository deletes nothing.

CI "validation" is GitHub's own checks, ignoring snapgit's jobs. Right after a push, "no checks yet" is read as "not started"
for 30 seconds (`ci-grace-seconds`). Set `"requireChecks": true` in `snapgit.json` if no checks at all must never count as
passing (for example when first-time contributors' workflows wait for approval).

Published branch timers (`refs/snapgit/timer/*`, pushed by `snapgit push` / `pr send -r`) are enforced by the scheduled
run, so a branch dies on time even if nobody's laptop is awake.

## Inputs

`token` (defaults to `github.token`), `mode` (`auto`, `sweep`, `wait`), `pr` (for `wait`), `max-wait` (seconds a wait job may
sleep, default 21000), `opt-in` (`all` by default; `label` touches only PRs labelled `snapgit`, the safe way to pilot), `metrics-branch` (default `snapgit-metrics`; `none` disables outcome recording), `poll-seconds` (default 20), `ignore-checks` (name prefixes, default `snapgit`), `ci-grace-seconds` (default 30).
Outputs: `wait-pr`, `wait-until` (set when a fuse was lit, so a second job can wait on it).

## Honest limits

- **Branch protection.** GitHub refuses merges that don't satisfy required reviews. merge-by-silence and "require approving
  reviews" contradict each other: use required *status checks* only for snapgit PRs, or let the Action's identity bypass.
  A refused merge is held with GitHub's reason.
- **Waiting costs runner minutes.** A wait job sleeps until the fuse burns out (cancelled and restarted by newer events).
  Beyond `max-wait` the five-minute scheduled sweep takes over, so a one-hour fuse may land up to five minutes late.
- **Forks.** The workflow uses `pull_request_target` so it can write; it never checks out or runs PR code, only reads the
  API. Branches of forks are never deleted.
- **Not tested against live GitHub from here.** The REST client and engine run against an in-memory GitHub served over
  HTTP in `test/`, not the real API. Try it on a scratch repository first.
- Status comments written by humans are ignored (only the bot's count), so the fuse can't be forged by pasting one.
