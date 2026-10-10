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

## Pull requests with one button

```
snapgit pr send feat -m "Add feature\nlook at this" -r origin   # ask for a merge; puts the branch on the clock
snapgit pr open <id> -r origin                                  # read it once; the contents then burn
snapgit pr reject <id> -m "no" -r origin                        # the only button there is
snapgit pr ls -r origin                                         # live PRs
snapgit pr burn <id> -r origin                                  # sender withdraws it (nothing merges)
```

There is no approve. A PR can only be rejected, and **if nobody rejects it before its branch expires, it merges into the
base branch** when the branch self-destructs. Its deadline *is* the branch timer (`snapgit extend` moves both; `snapgit keep`
refuses while a PR is live). The sender's `sweep` does the merge, then deletes the branch.

How the merge happens: with the base branch not checked out it is a plumbing merge (`merge-tree` + `commit-tree`), so no
working tree is touched. With the base checked out it is a normal `git merge --no-ff`, but only if the tree is clean. Conflicts,
a dirty base, or a remote that can't be reached to check for a rejection all **hold** the merge: nothing merges and the branch
is *not* deleted, and every sweep says why. A rejection counts only if it was made before the deadline. The hooks `snapgit init`
installs merge locally; add `--remote` (`snapgit sweep --remote origin`) to also push the merged base and delete the remote branch.

Reading is once-only. A PR is a JSON blob under `refs/snapgit/pr/<id>`. The first reader claims a receipt ref with a create-only
push (only one racer succeeds), and the PR is rewritten without its message, commits and patch. The PR itself stays alive so it can
still be rejected or merged. Recipients keep no local copy. Piping the output (a screenshot, in spirit) is refused without reading,
unless you pass `--screenshot`, which opens it anyway and records that you took one.

Honest caveat: burning replaces the ref, not the bytes. Old blobs linger as unreachable objects until git gc prunes them, and
anyone with the sender's repo can still read the original.

## Read receipts

Opening a PR also writes a receipt (`refs/snapgit/receipt/<id>`) saying who opened it, when, and whether they screenshotted.
`snapgit pr receipts` shows the receipts for PRs you sent, then deletes them. Receipts addressed to other people are never
shown or deleted by you. Collecting a receipt also refreshes your local copy of the PR to its burned version.

## Streaks and stories

`snapgit streak` counts consecutive days with a commit by you, across all branches. Commit yesterday and you're still alive.
`snapgit story [--since 24h]` summarises your last day: commits, branches on the clock, pending PRs. It is not saved anywhere.

## Tests

`npm test` runs against real temporary repos, including two clones racing to open the same PR. `SNAPGIT_NOW` (epoch ms)
overrides the clock for time travel.

## The video

`docs/video/snapgit.mp4` is a two-and-a-half-minute pitch built from `docs/video/scenes.json` with the same pipeline as the
SecondBrainClaude walkthrough: HTML slides, headless Chromium screenshots, offline Kokoro narration, ffmpeg.
The terminal slides are real captured output. Rebuild with
`PYTHON=<python with kokoro-onnx soundfile pillow> docs/video/build.sh` (needs node, ffmpeg, Chromium; the first run downloads
~350 MB of voice models). The outage figures come from press and third-party trackers, listed on the last slide.
