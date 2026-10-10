import { spawnSync } from 'node:child_process';
import { git, run } from './git.js';
import { now } from './time.js';

const AGENT = /claude|copilot|gpt|openai|gemini|cursor|devin|codex|aider|\bbot\b|\[bot\]|agent/i;
const SHAME = [
  'CI said no. The branch has left the building.',
  'It worked on your machine. It was the only place it worked.',
  'The tests were right. You were not.',
  'Whoever wrote this: the pipeline has feelings, and they are hurt.',
  'Zero reviewers were harmed. One branch was.',
  'This is not a drill. It is a red build.',
];

/** Everyone who wrote the branch: commit authors plus Co-Authored-By trailers, flagged if they look like an agent. */
export function authorsOf(base, head, cwd) {
  const people = new Map();
  const add = (name, email) => {
    const key = email.toLowerCase();
    if (!people.has(key)) people.set(key, { name, email, agent: AGENT.test(`${name} ${email}`) });
  };
  const log = git(['log', '--format=%an%x09%ae%x09%b%x1e', `${base}..${head}`], { cwd });
  for (const entry of log.split('\x1e').filter((e) => e.trim())) {
    const [name, email, ...body] = entry.trim().split('\t');
    add(name, email);
    for (const m of body.join('\t').matchAll(/^Co-Authored-By:\s*(.+?)\s*<([^>]+)>/gim)) add(m[1], m[2]);
  }
  return [...people.values()];
}

export function shameRecord({ rec, failure, authors }) {
  const pick = SHAME[parseInt(rec.id.slice(0, 4), 16) % SHAME.length];
  const who = authors.map((a) => `${a.name}${a.agent ? ' (agent)' : ''}`).join(', ');
  return {
    v: 1,
    id: rec.id,
    title: rec.title,
    head: rec.head,
    base: rec.base,
    authors,
    check: failure.name,
    exitCode: failure.code,
    timedOut: failure.timedOut,
    output: failure.output,
    at: now(),
    message: `${pick} PR ${rec.id} "${rec.title}" failed the "${failure.name}" check${failure.timedOut ? ' (timed out)' : ` (exit ${failure.code})`}. Shame on: ${who}. ${rec.head} is self-destructing. Fix it and send it again.`,
  };
}

/** Pipe the record, as JSON on stdin, into the user's own notifier (Slack poster, agent feed...). */
export function notify(record, cwd) {
  const cmd = run(['config', 'snapgit.shameCommand'], { cwd }).out.trim();
  if (!cmd) return null;
  const r = spawnSync('sh', ['-c', cmd], { cwd, input: JSON.stringify(record), encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? null : `shameCommand failed (exit ${r.status})`;
}
