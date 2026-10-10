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
snapgit pr open <id> -r origin                                  # view the changed code; lights a 60 second fuse
snapgit pr reject <id> -m "no" -r origin                        # the only button there is
snapgit pr ls -r origin                                         # live PRs
snapgit pr burn <id> -r origin                                  # sender withdraws it (nothing merges)
snapgit watch -r origin                                         # keep sweeping so fuses burn on time
```

There is no approve. A PR can only be rejected. **It merges 60 seconds after it is first opened unless rejected**, or, if nobody
ever opens it, when its branch expires, whichever comes first. The opener can re-read the changed code until the fuse runs out;
nobody else can open it (they can still reject). `snapgit extend` moves the branch deadline, and `snapgit keep` refuses while a PR is live.

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

`docs/video/snapgit-tiktok.mp4` is a 40 second 1080x1920 pitch for TikTok, built from `docs/video/scenes.json`: HTML slides,
headless Chromium screenshots, offline Kokoro narration, ffmpeg. The terminal slides are real captured output. Rebuild with
`PYTHON=<python with kokoro-onnx soundfile pillow> docs/video/build.sh` (needs node, ffmpeg, Chromium; the first run
downloads ~350 MB of voice models). Caption and hashtags: `docs/video/tiktok-caption.txt`. The outage figures come from
press and third-party trackers.
