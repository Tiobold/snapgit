# snapgit as a GitHub Action

The same rules as the CLI, on real GitHub PRs, with nothing to host. State lives in one bot comment per PR.

## Install

Copy [`examples/snapgit.yml`](examples/snapgit.yml) to `.github/workflows/snapgit.yml` on your default branch, and
(optionally) add a `snapgit.json` to it (see the main README). Name every job `snapgit...`: snapgit ignores check runs
whose name starts with `snapgit` so it never waits on itself.

PRs opened after the workflow lands go on the clock. Older PRs are left alone until you add the `snapgit` label.

## How a PR moves

| What happens | Result |
|---|---|
| PR opened | A status comment: size, the **fuse** (10s + 0.5s per line, ignoring lockfiles etc.), and when it dies unopened (`ttlHours`, default 24) |
| A reviewer comments `/snapgit open`, or submits a review | The fuse is lit (never by the PR's author). The workflow's wait job sleeps until it burns out |
| A reviewer comments `/snapgit reject [reason]`, or requests changes | Closed, labelled `snapgit:rejected` |
| Fuse burns out, CI green or absent | Merged (`mergeMethod`), branch deleted, labelled `snapgit:merged` |
| Fuse burns out, CI red | The authors are shamed (agents flagged), PR closed, branch deleted, `snapgit:shamed` |
| CI still running | Held until it finishes (said once) |
| Nobody ever opened it | Closed and deleted at expiry, `snapgit:expired`. **Nothing merges on a timer alone** |
| New commits after opening | The fuse goes out; a reviewer must look again |
| Touches `protectedPaths` | Also needs a reviewer's `/snapgit approve`; unapproved at expiry it is deleted |
| `/snapgit undo` (reviewers) | GitHub's own revert, as a new PR that goes through snapgit like any other |
| `frozen: true` in `snapgit.json` | Nothing merges or disappears |

Reviewers come from `snapgit.json` (`"@alice"` logins) or `"reviewers": "CODEOWNERS"` (individual owners; teams can't be
resolved). With no reviewers configured anyone but the author can open. Authors can reject (withdraw) their own PRs.

Published branch timers (`refs/snapgit/timer/*`, pushed by `snapgit push` / `pr send -r`) are enforced by the scheduled
run, so a branch dies on time even if nobody's laptop is awake.

## Inputs

`token` (defaults to `github.token`), `mode` (`auto`, `sweep`, `wait`), `pr` (for `wait`), `max-wait` (seconds a wait job may
sleep, default 21000), `poll-seconds` (default 20), `ignore-checks` (name prefixes, default `snapgit`).
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
