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
`--screenshot`, which opens it anyway and tells you it noticed. Nobody is notified. We have no servers.

Honest caveat: burning removes the ref, not the bytes. The blob lingers as an unreachable object until git gc prunes it.

## Streaks

`snapgit streak` counts consecutive days with a commit by you, across all branches. Commit yesterday and you're still alive.

## Tests

`npm test` runs against real temporary repos, including two clones racing to open the same PR. `SNAPGIT_NOW` (epoch ms)
overrides the clock for time travel.
