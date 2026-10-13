# snapgit

Git meets Snapchat. Branches that disappear, pull requests with one button, CI that shames the author and
deletes the branch, and an undo for everything. A joke with a pitch (AI writes PRs in minutes, review takes days),
but every feature really works, on plain git or on real GitHub PRs.

```
npx github:Tiobold/snapgit help      # or: npm i -g github:Tiobold/snapgit     (Node 20+)
snapgit init              # hooks, so sweeping happens by itself
snapgit init --agent      # teach coding agents the rules (skill + AGENTS.md)
snapgit init --workflow   # put real GitHub PRs on the clock (the Action)
```

## The model in four rules

1. **Every branch has a timer** (24h by default, chosen once, never extended). When it runs out it is deleted.
2. **A PR has one button: reject.** There is no approve. A reviewer *opens* it, which lights a **fuse sized to the change**
   (10s + 0.5s per changed line, 15s to 1h). Unrejected when the fuse burns out, it **merges**.
3. **Nobody looks, nothing merges.** A PR that is never opened is **deleted** when its branch expires. Silence from a
   whole team never ships code.
4. **CI is law.** Checks run when you send and again before the merge. Fail, and the authors (human or agent) are
   shamed and the branch self-destructs. Everything is recoverable (`undo`, `resurrect`).

## Branches

```
snapgit snap wip/spike              # git switch -c, plus a self-destruct timer (24h by default)
snapgit snap wip/spike --ttl 2h     # choose once, at creation
snapgit ls                          # what's on the clock
snapgit sweep [-r origin]           # delete everything expired (and expired remote branches)
snapgit watch [-r origin]           # keep sweeping every few seconds
snapgit init                        # git hooks that sweep after commit/checkout/merge (offline)
git config snapgit.defaultTtl 8h    # change the default for this repo
```

There is no `extend` and no `keep`. snapgit only puts timers on branches made with `snap` or sent with `pr send`; it never
starts a timer on a branch you already have. Protected branches (main, master, trunk, develop, the origin default) can't get one,
and a checked-out branch waits until you leave it.

**Any runner can enforce a timer.** `snapgit push` (and `pr send -r`) publishes the timer as `refs/snapgit/timer/<branch>`.
Then `snapgit sweep -r origin` on *any* machine, or the GitHub Action, deletes the expired branch. Timers are immutable on the
remote. Branches with a live PR are left to their PR.

## Pull requests

```
snapgit pr send [branch] -m "title\nbody" -r origin   # CI runs first; the branch goes on the clock
snapgit pr open <id> -r origin       # read the changes; lights the fuse. Only the opener can re-read it
snapgit pr reject <id> -m "no"       # the only button
snapgit pr approve <id>              # only for PRs touching protectedPaths (see below)
snapgit pr ls | checks <id> | receipts | burn <id>
```

A reviewer opens a PR and the clock starts. Opening gives *them* the changed code and nobody else (a second person is
locked out of reading but can still reject). When the fuse burns out the sender's `sweep` / `watch` merges it: a
plumbing merge (`merge-tree` + `commit-tree`) if the base isn't checked out, a fast-forward of the merge commit if it is
and the tree is clean. Conflicts, a dirty base, or an unreachable remote **hold** the merge and keep the branch. Add
`--remote` to also push the result. A rejection only counts if it arrived before the fuse burned out. Piping `pr open`
(a screenshot, in spirit) is refused unless you pass `--screenshot`, which opens it anyway and records that you did.

**Validated before review.** `pr send` runs the CI checks first, so a PR only exists once validation passed
(`pr open` shows "validated before review"); nothing is reviewable, and no fuse can start, before that. Failing validation shames
the authors and destroys the branch before anyone has to look.

**The merge is of what was reviewed.** The PR records the commit it describes. If the branch moves after that, the sweep
refreshes the record, voids the opening and any approval, and a reviewer has to open it again. Protected paths are recomputed
from the real diff at merge time. Opening needs at least one full fuse of lifetime left (a fuse cut short by the deadline would
be a rubber stamp), so a PR opened too late is simply deleted with its branch.

**Withdrawing.** Only the sender can `pr burn` a PR. If a PR disappears from its remote behind the sender's back the sweep
treats it as withdrawn and merges nothing. A rejection by a reviewer, or by the sender withdrawing their own PR, counts.

**Read receipts**: `pr receipts` lists who opened your PRs, when, and whether they screenshotted.

## Rules: `snapgit.json` on the base branch

The file lives on the **base** branch, so a PR can't rewrite its own rules. No file means defaults.

```json
{
  "checks": [{ "name": "tests", "run": "npm ci && npm test", "timeoutSec": 300 }],
  "fuse": {
    "baseSec": 10, "secPerLine": 0.5, "minSec": 15, "maxSec": 3600,
    "ignore": ["package-lock.json", "**/*.lock", "dist/"],
    "weights": [{ "glob": "migrations/**", "multiplier": 3 }, { "glob": "**/*.md", "multiplier": 0.25 }]
  },
  "reviewers": ["@alice", "bob@example.com"],
  "protectedPaths": ["auth/**", "infra/**"],
  "mergeMethod": "squash", "ttlHours": 24, "frozen": false, "requireChecks": false
}
```

`snapgit policy` prints what applies. A malformed file **holds** merges instead of guessing.

- **Fuse sizing.** Lockfiles and build output (`ignore`) count for nothing; `weights` make a migration count triple and a
  README a quarter. A one-line fix gets 15 seconds, 100 lines a minute, 500 lines 4m 20s, a 30,000 line PR the one-hour ceiling.
  `git config snapgit.fuseSecPerLine 1` (and `fuseBaseSec`, `fuseMinSec`, `fuseMaxSec`) override the file locally.
- **Reviewers.** When set, only they can open, reject or approve; nobody reviews their own PR; and a receipt or rejection
  left by a non-reviewer is ignored when the sender settles (so nobody can squat a PR or forge a veto). Use `"reviewers":
  "CODEOWNERS"` to take the individual owners from the base branch's CODEOWNERS. Set `git config snapgit.githubLogin <you>`
  so the CLI identifies you the way the web UI does.
- **Identity.** `@alice` matches an identity only through a GitHub noreply address (set `snapgit.githubLogin`), never through
  a self-asserted `user.name`. "Your own PR" means the same email or login, so renaming yourself doesn't help.
- **Protected paths.** PRs touching them don't merge by silence: a reviewer must `pr approve`. Unapproved when the branch
  expires, they are deleted. This is the one exception to "no approve".

## CI checks and shame

Checks run at `pr send` (fail fast, before anyone looks) and again right before the merge, against the **merge result**
in a throwaway worktree (your own tree is never touched). `pr checks <id>` previews them. If one fails or times out:

- nothing merges; the people who wrote it are **shamed** (commit authors plus `Co-Authored-By` trailers, agents such as
  Claude, Copilot and Cursor flagged) with the failing output;
- the branch **self-destructs** now, not at its timer (recoverable, see below);
- the record is published as `refs/snapgit/shame/<id>`: `snapgit shame` (`--json` for an agent, `--clear` to dismiss) from any clone.

Checks run the PR's code on the machine that sweeps, like any CI runner, and they run inside the git hooks too: keep them
quick, or let `snapgit watch` or the Action do the sweeping.

## Safety nets

```
snapgit undo <id> [--push -r origin]  # revert a snapgit merge: a revert commit on top, history never rewritten
snapgit merged                        # the ledger undo works from
snapgit graveyard / resurrect <name>  # ghosted branches stay reachable for 30 days (snapgit.graveyardDays)
snapgit freeze [reason] [-r origin]   # kill switch: nothing merges, nothing disappears (also for other runners)
snapgit thaw [-r origin]
```

`undo` refuses (and changes nothing) if later work makes the revert conflict. A resurrected branch gets a fresh timer:
nothing escapes the clock. Frozen items that came due settle at the next sweep after `thaw`.

## Notifications

```
git config snapgit.slackWebhook https://hooks.slack.com/...      # one line of text per event
git config snapgit.notifyCommand 'curl -s -X POST ... -d @-'     # event JSON on stdin, $SNAPGIT_EVENT in the env
```

Events: `sent`, `opened`, `halfway` (half the fuse is gone), `merged`, `rejected`, `shamed`, `expired`, `held`, `undone`.
A failing notifier is reported but never breaks snapgit. `snapgit.shameCommand` (shamed only) still works, which is how
you hand the failure back to the coding agent that wrote the change.

## On real GitHub PRs: the Action

Most teams review in GitHub, so `action.yml` applies the same rules to ordinary PRs, with no server: a reviewer says
`/snapgit open` (or submits a review), the PR merges when its fuse burns out unless a reviewer says `/snapgit reject` (or
requests changes), CI is GitHub's own checks, and `/snapgit undo` opens a GitHub revert PR. Unopened PRs are closed and
their branches deleted; shamed PRs too. See [action/README.md](action/README.md) for the workflow to paste in.

## For coding agents

AI agents are the reason review is the bottleneck, so snapgit is built to be used by them. `snapgit skill` prints a
short skill (the rules, the workflow, good behavior) and `snapgit init --agent` writes it to `.claude/skills/snapgit/SKILL.md`
plus an idempotent block in `AGENTS.md`. The source is [skills/snapgit/SKILL.md](skills/snapgit/SKILL.md). Commands agents
parse have `--json`: `snapgit status --json` (what is on the clock, live PRs, frozen), `snapgit ls --json`,
`snapgit pr ls --json`, and `snapgit pr send --json` (`{ok, id, lines, fuseMs, ...}`, or `{ok:false, shamed:{...}}` with exit 1
when CI fails). The skill tells an agent to run the project's tests before sending, because failing CI deletes its branch.

## Metrics

`snapgit metrics` (or the dashboard at `web/metrics.html`) answers: did review get faster, how many PRs did nobody open, how often do reviewers reject, and do agent-written PRs fail CI more than human ones.

```
snapgit metrics --since 30d              # table in the terminal
snapgit metrics --json | --csv | --records
snapgit metrics --publish                # push outcomes.json to the snapgit-metrics branch for the dashboard
```

Every settled PR leaves an outcome record under `refs/snapgit/outcome/` (the Action appends to `outcomes.json` on the
`snapgit-metrics` branch; set `metrics-branch: none` to turn that off). Records hold timings, size and kind only: no
author, title or branch. Groups are **teams** (`"teams": {"payments": ["ana", "bo"]}` in `snapgit.json`) and agent-or-human,
never people; groups under 3 PRs are suppressed and CSV exports are anonymous. The baseline is the repository's ordinary
closed PRs before the first snapgit PR (or those that skipped snapgit). It is a comparison, not proof: it only sees PRs that
settled, so survivorship bias and team or season differences apply.

## Web

`web/` is a static site: review a PR in a browser, with a size-based countdown, by talking to the GitHub API, plus the
metrics dashboard at `/metrics`. See [web/README.md](web/README.md).

**Getting a token.** Opening or rejecting in the browser needs a GitHub token (a page cannot sign you in without a server,
and snapgit has none). Create a fine-grained one at <https://github.com/settings/personal-access-tokens/new>: only your
repository, **Contents: Read and write** (the dashboard alone needs Contents and Pull requests read-only). It stays in the
tab's memory and goes only to `api.github.com`. Details, and the classic-token and SSO route: [web/setup.html](web/setup.html).

**Sign in with GitHub (optional, no token to make).** The site's operator registers **one public GitHub App** once
(`/create-app` does it in two clicks) and puts its client ID and secret in the host's environment. After that anyone can press
*Sign in with GitHub* and install the App on just the repositories they review in: no token, no Vercel account, no App of their
own. The App only gets Contents read/write and Pull requests read, tokens expire after about 8 hours, and they reach the page
in the URL fragment. The server side is three stateless functions in `web/api/`. Copies without them (GitHub Pages, plain static
hosts) just don't show the button and keep the token field. Details: [web/setup.html](web/setup.html#signin).

**Hosting it yourself on GitHub Pages.** Fork this repository, set Settings, Pages, Source to *GitHub Actions*, then run
the *Deploy web to GitHub Pages* workflow from the Actions tab. Your copy lives at `https://<you>.github.io/snapgit/`.
Vercel (Root Directory `web`) or any static host works too, and `npx serve web` runs it locally.

## For fun

`snapgit streak` (commit streak) and `snapgit story` (your last day in git, which will not be saved).

## Tests, platforms, the video

`npm test` runs ~150 tests against real temporary git repos, two clones racing, and the Action against an in-memory GitHub
served over HTTP. `npm run test:e2e` drives the web UI in Chromium. CI runs on Linux, macOS and Windows; tests that need a unix
shell (`cat`, `test -f`) skip on Windows. `SNAPGIT_NOW` (epoch ms) overrides the clock; `SNAPGIT_FUSE_MS` pins the fuse.

`docs/video/snapgit-tiktok.mp4` is the roughly two minute 1080x1920 pitch, built by `docs/video/build.sh` from `scenes.json` (HTML
slides, headless Chromium, offline Kokoro narration, ffmpeg). Caption and hashtags: `docs/video/tiktok-caption.txt`.

## Trust model

snapgit's rules stop mistakes, lazy shortcuts and accounts without the right standing. They do **not** stop someone with push
access to the remote from rewriting `refs/snapgit/*` by hand: git has no per-ref permissions. If that matters, restrict
those refs with your host's rulesets or branch/ref protection, and keep the reviewers list short. On GitHub the Action
sidesteps this: its state lives in a bot comment only the Action's token can write.

## Honest limits

- The sender's machine (or the Action) merges. A closed laptop with no Action merges nothing, and a 15-second fuse needs
  something awake to notice it.
- "Only the opener can read it" is a rule of the tool, not encryption: the patch sits readable in the PR ref.
- Clocks come from each machine. Heavy skew shifts a fuse.
- GitHub mode can't merge past branch protection that demands approving reviews: relax it for snapgit PRs or let the
  bot bypass it, and see "Honest limits" in the Action README.
- The outage figures in the video come from press and third-party trackers.
