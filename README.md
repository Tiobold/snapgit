# snapgit

Git meets Snapchat. A joke, but every feature really works, on top of plain git. Zero dependencies, Node 20+.

```
npm link            # puts `snapgit` on your PATH (or run node bin/snapgit.js)
snapgit init        # optional: hooks so expired branches vanish on their own
```

## Disappearing branches

```
snapgit snap wip/spike --ttl 2h     # git switch -c, plus a self-destruct timer
snapgit ls                          # what's on the clock
snapgit extend wip/spike 1h         # buy time
snapgit keep wip/spike              # "save to memories": remove the timer
snapgit sweep [--remote origin]     # delete everything expired (also the remote branch)
```

The timer lives in your git config (`branch.<name>.snapgit-expires`). Expiry is enforced by `sweep`, which runs from the
git hooks `snapgit init` installs and every time you run `snapgit ls`. Rules: protected branches (main, master, trunk,
develop, the origin default) can't get a timer, and a checked-out branch is never deleted, it just waits for you to leave.
Ghosting prints the old tip so `git branch <name> <sha>` brings it back (until git gc).

## View-once pull requests

```
snapgit pr send -m "Add feature\nlook at this" -r origin    # freeze head...base diff, push as refs/snapgit/pr/<id>
snapgit pr open <id> -r origin                              # read it once; it is deleted as you open it
snapgit pr ls -r origin                                     # unopened PRs
snapgit pr burn <id> -r origin                              # retract without reading
```

A PR is a JSON blob (message, commits, stat, full patch) in a private ref, so any git remote can carry it. Opening
deletes the ref on the remote *before* showing you anything. `git push --delete` succeeds for exactly one person, so if
two people race, one gets the PR and the other gets "already burned". The sender's own copy dies with it. PRs also expire
unopened (default 24h). Piping the output (a screenshot, in spirit) is refused without burning, unless you pass
`--screenshot`, which opens it anyway and records that you took one.

Honest caveat: burning removes the ref, not the bytes. The blob lingers as an unreachable object until git gc prunes it.

## Read receipts

Opening a PR also writes a receipt (`refs/snapgit/receipt/<id>`) saying who opened it, when, and whether they screenshotted.
`snapgit pr receipts` shows the receipts for PRs you sent, then deletes them. Receipts addressed to other people are never
shown or deleted by you. Opening a PR you sent yourself clears your stale local copy once its receipt arrives.

## Streaks and stories

`snapgit streak` counts consecutive days with a commit by you, across all branches. Commit yesterday and you're still alive.
`snapgit story [--since 24h]` summarises your last day: commits, branches on the clock, pending PRs. It is not saved anywhere.

## Tests

`npm test` runs against real temporary repos, including two clones racing to open the same PR. `SNAPGIT_NOW` (epoch ms)
overrides the clock for time travel.

## The video

`docs/video/snapgit.mp4` is a two-minute pitch built from `docs/video/scenes.json` with the same pipeline as the
SecondBrainClaude walkthrough: HTML slides, headless Chromium screenshots, offline Kokoro narration, ffmpeg.
The terminal slides are real captured output. Rebuild with
`PYTHON=<python with kokoro-onnx soundfile pillow> docs/video/build.sh` (needs node, ffmpeg, Chromium; the first run downloads
~350 MB of voice models). The outage figures come from press and third-party trackers, listed on the last slide.
