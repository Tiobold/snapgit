import { git } from './git.js';
import { now } from './time.js';
import { listSnaps } from './snaps.js';
import { listLocalPrs } from './pr.js';
import { streak } from './streak.js';

/** Everything you did in the last windowMs, across all branches. */
export function story(cwd, windowMs) {
  const email = git(['config', 'user.email'], { cwd });
  const since = new Date(now() - windowMs).toISOString();
  const log = git(['log', '--all', `--author=${email}`, `--since=${since}`, '--format=%h\t%s\t%D'], { cwd });
  const commits = log.split('\n').filter(Boolean).map((l) => {
    const [sha, subject, refs] = l.split('\t');
    return { sha, subject, refs: refs?.split(', ').filter((r) => r && !r.startsWith('HEAD')).join(', ') || 'no branch tip' };
  });
  return {
    commits,
    snaps: listSnaps(cwd).filter((b) => b.expiresAt > now()),
    prs: listLocalPrs(cwd),
    streak: streak(cwd),
  };
}
