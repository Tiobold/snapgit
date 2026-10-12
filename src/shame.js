import { git } from './git.js';
import { now } from './time.js';

export const AGENT = /claude|copilot|gpt|openai|gemini|cursor|devin|codex|aider|\bbot\b|\[bot\]|agent/i;
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

export const isAgent = (name, email = '') => AGENT.test(`${name} ${email}`);

/** The message itself, shared by the CLI and the GitHub Action. */
export function shameMessage({ id, label = `PR ${id}`, title, head, failure, authors }) {
  const pick = SHAME[parseInt(String(id).slice(0, 4), 16) % SHAME.length] ?? SHAME[0];
  const who = authors.map((a) => `${a.name}${a.agent ? ' (agent)' : ''}`).join(', ');
  return `${pick} ${label} "${title}" failed the "${failure.name}" check${failure.timedOut ? ' (timed out)' : failure.code === undefined || failure.code === null ? '' : ` (exit ${failure.code})`}. Shame on: ${who}. ${head} is self-destructing. Fix it and send it again.`;
}

export function shameRecord({ rec, failure, authors }) {
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
    message: shameMessage({ id: rec.id, title: rec.title, head: rec.head, failure, authors }),
  };
}
