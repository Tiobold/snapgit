import { run } from './git.js';

/** Who am I? "Name <email>", or the GitHub noreply form when snapgit.githubLogin is set (so CLI and web agree). */
export function ident(cwd) {
  const login = run(['config', 'snapgit.githubLogin'], { cwd });
  if (login.ok && login.out.trim()) return `${login.out.trim()} <${login.out.trim()}@users.noreply.github.com>`;
  return `${run(['config', 'user.name'], { cwd }).out.trim()} <${run(['config', 'user.email'], { cwd }).out.trim()}>`;
}

/** "Name <email>" -> { name, email, login }. The login is read from GitHub noreply addresses. */
export function parseIdent(ident) {
  const m = String(ident).match(/^(.*?)\s*<([^>]*)>\s*$/);
  const name = (m ? m[1] : String(ident)).trim();
  const email = (m ? m[2] : '').trim().toLowerCase();
  const noreply = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  return { name, email, login: noreply ? noreply[1].toLowerCase() : null };
}

/** Does this identity match a reviewer entry? Entries are "@login", "login" or an email address. */
export function matchesReviewer(ident, entry) {
  const who = parseIdent(ident);
  const e = String(entry).trim().toLowerCase();
  if (e.includes('@') && !e.startsWith('@')) return who.email === e;
  const login = e.replace(/^@/, '');
  return who.login === login || (!!who.name && who.name.toLowerCase() === login);
}

/** reviewers === null means anyone may review. Otherwise the identity must match an entry. */
export const isReviewer = (ident, reviewers) => !reviewers || reviewers.some((r) => matchesReviewer(ident, r));

/** Owners named anywhere in a CODEOWNERS file: "@login" tokens and email addresses. */
export function parseCodeowners(text) {
  const owners = new Set();
  for (const line of text.split('\n')) {
    const [, ...tokens] = line.replace(/#.*$/, '').trim().split(/\s+/);
    for (const t of tokens) if (t.startsWith('@') && !t.includes('/') ) owners.add(t.toLowerCase());
    else if (t.includes('@') && !t.startsWith('@')) owners.add(t.toLowerCase());
  }
  return [...owners];
}

/** The reviewer list a policy implies: null (anyone), or a list of people. */
export function resolveReviewers(policy, base, cwd) {
  if (policy.reviewers === null) return null;
  if (policy.reviewers !== 'CODEOWNERS') return policy.reviewers;
  for (const path of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
    const r = run(['show', `refs/heads/${base}:${path}`], { cwd });
    if (r.ok) {
      const owners = parseCodeowners(r.out);
      if (!owners.length) throw new Error(`${path} on ${base} names no individual owners (teams cannot be resolved offline)`);
      return owners;
    }
  }
  throw new Error(`reviewers is "CODEOWNERS" but ${base} has no CODEOWNERS file`);
}
