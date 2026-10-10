import { git } from './git.js';
import { now } from './time.js';

const DAY = 864e5;
const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const today = () => dayNumber(new Date(now()).toISOString().slice(0, 10));

/** Commit streaks for the configured user. A streak is still alive if you committed yesterday. */
export function streak(cwd) {
  const email = git(['config', 'user.email'], { cwd });
  const out = git(['log', '--all', `--author=${email}`, '--format=%ad', '--date=format:%Y-%m-%d'], { cwd });
  const days = [...new Set(out.split('\n').filter(Boolean).map(dayNumber))].sort((a, b) => b - a);
  if (!days.length) return { current: 0, longest: 0, doneToday: false };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i - 1] - days[i] === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const t = today();
  let current = 0;
  if (days[0] === t || days[0] === t - 1) {
    current = 1;
    while (current < days.length && days[current - 1] - days[current] === 1) current++;
  }
  return { current, longest, doneToday: days[0] === t };
}
