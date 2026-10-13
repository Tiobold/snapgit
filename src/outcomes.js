import { git, run } from './git.js';
import { matchesReviewer } from './authz.js';
import { authorsOf } from './shame.js';
import { loadPolicy } from './policy.js';
import { now } from './time.js';

// What happened to each PR, kept after the PR itself is gone: refs/snapgit/outcome/<id>. The record names a team and an
// "agent-authored" flag, never a person. `snapgit metrics` and the dashboard read these. Recording never breaks a settle.
const REF = 'refs/snapgit/outcome/';
const SCRATCH = 'refs/snapgit-remote/outcome/';

/** The first team in the policy whose member list matches this identity (or null). */
export function teamOf(identity, teams = {}) {
  for (const [name, members] of Object.entries(teams)) if (members.some((m) => matchesReviewer(identity, m))) return name;
  return null;
}

export function recordOutcome({ cwd, via, rec, kind, receipt = null }) {
  try {
    let agent = false;
    let team = null;
    try { agent = authorsOf(rec.base, rec.head, cwd).some((a) => a.agent); } catch { /* branch gone: unknown, count as human */ }
    try { team = teamOf(rec.author, loadPolicy(rec.base, cwd).teams); } catch { /* no policy */ }
    const outcome = {
      v: 1, id: rec.id, src: 'cli', kind, createdAt: rec.createdAt, validatedAt: rec.validated?.at ?? rec.createdAt,
      openedAt: receipt?.openedAt ?? null, settledAt: now(), lines: rec.lines ?? 0, fuseMs: rec.fuseMs ?? null, agent, team, undone: false,
    };
    const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify(outcome) });
    git(['update-ref', REF + rec.id, blob], { cwd });
    if (via) run(['push', '--force', via, `${REF + rec.id}:${REF + rec.id}`], { cwd });
  } catch { /* metrics are a bystander */ }
}

/** A merged PR was reverted: the quality signal that matters most. */
export function markUndone(id, { cwd, via }) {
  try {
    const sha = run(['rev-parse', '--verify', '-q', REF + id], { cwd });
    if (!sha.ok) return;
    const outcome = JSON.parse(git(['cat-file', 'blob', sha.out.trim()], { cwd }));
    const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify({ ...outcome, undone: true }) });
    git(['update-ref', REF + id, blob], { cwd });
    if (via) run(['push', '--force', via, `${REF + id}:${REF + id}`], { cwd });
  } catch { /* ignore */ }
}

/** Raw outcomes recorded here, plus (with a remote) everything other machines published. */
export function listOutcomes({ cwd, remote }) {
  if (remote) run(['fetch', '--quiet', remote, `+${REF}*:${SCRATCH}*`], { cwd });
  const out = [];
  for (const ns of remote ? [REF, SCRATCH] : [REF]) {
    for (const line of run(['for-each-ref', '--format=%(objectname)', ns], { cwd }).out.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(git(['cat-file', 'blob', line], { cwd }))); } catch { /* skip garbled */ }
    }
  }
  const byId = new Map();
  for (const o of out) if (!byId.has(o.id) || o.undone) byId.set(o.id, o); // a published copy and the local one are the same PR
  return [...byId.values()];
}

/** Publish outcomes.json on the branch snapgit-metrics (an orphan commit) so the dashboard can read it with one request. */
export function publishOutcomes({ cwd, remote, outcomes }) {
  const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify(outcomes) });
  const tree = git(['mktree'], { cwd, input: `100644 blob ${blob}\toutcomes.json\n` });
  const commit = git(['commit-tree', tree, '-m', `snapgit metrics: ${outcomes.length} outcomes`], { cwd });
  const r = run(['push', '--force', remote, `${commit}:refs/heads/snapgit-metrics`], { cwd });
  if (!r.ok) throw new Error(`could not publish to ${remote}: ${r.err}`);
  return outcomes.length;
}
