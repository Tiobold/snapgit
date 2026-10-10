# snapgit

Git meets Snapchat. A joke, but every feature really works, on top of plain git. Zero dependencies, Node 20+.

```
npm link            # puts `snapgit` on your PATH (or run node bin/snapgit.js)
snapgit init        # optional: hooks so expired branches vanish on their own
```

## Disappearing branches

```
snapgit snap wip/spike              # git switch -c, plus a self-destruct timer (24h by default)
snapgit snap wip/spike --ttl 2h     # pick another timer, once, at creation
snapgit ls                          # what's on the clock
snapgit sweep [--remote origin]     # delete everything expired (also the remote branch)
git config snapgit.defaultTtl 8h    # change the default for this repo
```

Every snap has a timer, and **timers can never be extended or removed**: there is no `extend` and no `keep`. Sending a PR for a
branch that has no timer puts it on the clock with the default, and `pr send --ttl` is refused for a branch that already has one.
(snapgit only puts timers on branches made with `snap` or sent with `pr send`; it never starts a timer on a branch you already have.)

The timer lives in your git config (`branch.<name>.snapgit-expires`). Expiry is enforced by `sweep`, which runs from the git
hooks `snapgit init` installs and every time you run `snapgit ls`. Protected branches (main, master, trunk, develop, the origin
default) can't get a timer, and a checked-out branch is never deleted, it just waits for you to leave. Ghosting prints the old tip
so `git branch <name> <sha>` brings it back (until git gc).

## Pull requests with one button

```
snapgit pr send feat -m "Add feature\nlook at this" -r origin   # ask for a merge; puts the branch on the clock
snapgit pr open <id> -r origin                                  # view the changed code; lights a 60 second fuse
snapgit pr reject <id> -m "no" -r origin                        # the only button there is
snapgit pr ls -r origin                                         # live PRs
snapgit pr burn <id> -r origin                                  # sender withdraws it (nothing merges)
snapgit watch -r origin                                         # keep sweeping so fuses burn on time
```

There is no approve. A PR can only be rejected. **It merges 60 seconds after it is first opened unless rejected**, or, if nobody
ever opens it, when its branch expires, whichever comes first. The opener can re-read the changed code until the fuse runs out;
nobody else can open it (they can still reject). The branch deadline can't be moved.

The merge is done by the sender's machine: `snapgit sweep` (or `snapgit watch`, which sweeps every few seconds) sees the receipt,
merges, and deletes the branch. The git hooks from `snapgit init` sweep offline, so they settle local PRs and leave PRs that
live on a remote to an online `sweep`/`watch`.

How the merge happens: with the base branch not checked out it is a plumbing merge (`merge-tree` + `commit-tree`), so no
working tree is touched. With the base checked out it is a normal `git merge --no-ff`, but only if the tree is clean. Conflicts,
a dirty base, or a remote that can't be reached to check for a rejection all **hold** the merge: nothing merges and the branch
is *not* deleted, and every sweep says why. A rejection counts only if it was made before the deadline. Add `--remote`
(`snapgit sweep --remote origin`) to also push the merged base and delete the remote branch.

A PR is a JSON blob under `refs/snapgit/pr/<id>`. The first opener claims `refs/snapgit/receipt/<id>` with a create-only push
(only one racer succeeds); its timestamp starts the fuse. Recipients keep no local copy. Piping the output (a screenshot, in
spirit) is refused without opening, unless you pass `--screenshot`, which opens it anyway and records that you took one.

Honest caveat: the patch stays readable in the ref and in the sender's repo, so "only the opener can read it" is a rule of
the tool, not encryption.

## CI checks, and shame

Put a `snapgit.json` on the **base** branch:

```json
{ "checks": [{ "name": "tests", "run": "npm ci && npm test", "timeoutSec": 300 }] }
```

Checks run twice: when you `snapgit pr send` (fail fast, before any human or agent has to look at it) and again right before the
merge, against the *merge result*, in a throwaway worktree so your own tree is never touched. `snapgit pr checks <id>` previews them
without consequences. The config is read from the base branch, so a PR cannot switch off its own CI. No file means no checks; a
malformed file holds the merge.

If a check fails (or times out), nothing merges, and:

- the people who wrote the branch are **shamed**: every commit author plus `Co-Authored-By` trailers, with agents (Claude, Copilot,
  Cursor, bots...) flagged as such, the failing check's output, and a message that is not subtle;
- the branch **self-destructs** immediately, not when its timer ends (the old tip is printed so it can be recovered);
- the record is stored as `refs/snapgit/shame/<id>` and pushed to the remote when there is one. Read it with `snapgit shame`
  (`--json` for an agent to consume, `--clear` to dismiss) from any clone;
- if `git config snapgit.shameCommand '<cmd>'` is set, the record is piped to it as JSON on stdin, so you can post it to Slack or
  hand it back to the coding agent that wrote the change.

Checks execute the PR's code on the machine that sweeps, like any CI runner would, and they run inside the git hooks too, so keep them
quick or let `snapgit watch` do the sweeping.

## Read receipts

Opening a PR also writes a receipt (`refs/snapgit/receipt/<id>`) saying who opened it, when, and whether they screenshotted.
`snapgit pr receipts` lists the receipts for PRs you sent. Receipts addressed to other people are never shown by you.
They are removed when the PR settles.

## Streaks and stories

`snapgit streak` counts consecutive days with a commit by you, across all branches. Commit yesterday and you're still alive.
`snapgit story [--since 24h]` summarises your last day: commits, branches on the clock, pending PRs. It is not saved anywhere.

## Tests

`npm test` runs against real temporary repos, including two clones racing to open the same PR. `SNAPGIT_NOW` (epoch ms)
overrides the clock for time travel.

## The web interface

`web/` is a static site for reviewing PRs in a browser (open, read the diff, 60 second countdown, reject), plus a demo
sandbox. It talks only to the GitHub API, so there is nothing to run. See `web/README.md` for the Vercel steps.

## The video

`docs/video/snapgit-tiktok.mp4` is a 53 second 1080x1920 pitch (leadership wants more AI, review is the bottleneck, snapgit's answer) for TikTok, built from `docs/video/scenes.json`: HTML slides,
headless Chromium screenshots, offline Kokoro narration, ffmpeg. The terminal slides are real captured output. Rebuild with
`PYTHON=<python with kokoro-onnx soundfile pillow> docs/video/build.sh` (needs node, ffmpeg, Chromium; the first run
downloads ~350 MB of voice models). Caption and hashtags: `docs/video/tiktok-caption.txt`. The outage figures come from
press and third-party trackers.
