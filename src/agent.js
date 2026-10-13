// Helpers for agents and onboarding: the bundled skill, an AGENTS.md block, and the Action workflow.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEGIN = '<!-- snapgit:begin -->';
const END = '<!-- snapgit:end -->';

export const skillText = () => readFileSync(resolve(HERE, '../skills/snapgit/SKILL.md'), 'utf8');

const root = (cwd) => resolve(cwd, git(['rev-parse', '--show-toplevel'], { cwd }));

const AGENTS_BLOCK = `${BEGIN}
## snapgit

This repository uses snapgit. Branches have timers that cannot be extended, pull requests have one button (reject), and a
PR nobody rejects merges. Run \`snapgit skill\` for the full rules, \`snapgit status --json\` for the current state, and send
work with \`snapgit pr send -m "title\\nwhy" -r origin --json\`. Run the project's tests before sending: failing CI deletes the branch.
${END}
`;

/** Write .claude/skills/snapgit/SKILL.md and an idempotent AGENTS.md block. Returns the files written. */
export function installAgent(cwd) {
  const top = root(cwd);
  const written = [];
  const skill = resolve(top, '.claude/skills/snapgit/SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, skillText());
  written.push('.claude/skills/snapgit/SKILL.md');
  const agents = resolve(top, 'AGENTS.md');
  const existing = existsSync(agents) ? readFileSync(agents, 'utf8') : '';
  const next = existing.includes(BEGIN)
    ? existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), AGENTS_BLOCK)
    : `${existing}${existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''}${AGENTS_BLOCK}`;
  if (next !== existing) { writeFileSync(agents, next); written.push('AGENTS.md'); }
  return written;
}

/** Copy the example workflow to .github/workflows/snapgit.yml. Never overwrites. Returns the path, or null if it exists. */
export function installWorkflow(cwd) {
  const file = resolve(root(cwd), '.github/workflows/snapgit.yml');
  if (existsSync(file)) return null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(resolve(HERE, '../action/examples/snapgit.yml'), 'utf8'));
  return '.github/workflows/snapgit.yml';
}
