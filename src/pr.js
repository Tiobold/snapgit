import { randomBytes } from 'node:crypto';
import { git, run, currentBranch, defaultBranch, hasRemote } from './git.js';
import { now } from './time.js';

const PREFIX = 'refs/snapgit/pr/';
const ID = /^[0-9a-f]{8}$/;
const refOf = (id) => {
  if (!ID.test(id)) throw new Error(`"${id}" is not a snapgit PR id (8 hex characters)`);
  return PREFIX + id;
};

/**
 * A PR is a JSON blob stored under refs/snapgit/pr/<id>. It carries a frozen copy
 * of the diff, so it needs nothing but a git remote to travel.
 */
export function createPr({ cwd, head, base, message, ttlMs, remote }) {
  head ||= currentBranch(cwd);
  if (!head) throw new Error('detached HEAD: name the branch to send');
  base ||= defaultBranch(cwd);
  const patch = git(['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], { cwd });
  if (!patch) throw new Error(`${head} has no changes relative to ${base}: nothing to send`);
  const lines = (message || '').split('\n');
  const record = {
    v: 1,
    id: randomBytes(4).toString('hex'),
    title: lines[0] || git(['log', '-1', '--format=%s', head], { cwd }),
    message: lines.slice(1).join('\n').trim(),
    author: `${git(['config', 'user.name'], { cwd })} <${git(['config', 'user.email'], { cwd })}>`,
    base,
    head,
    remote: remote || null,
    createdAt: now(),
    expiresAt: now() + ttlMs,
    commits: git(['log', '--format=%h %s', `${base}..${head}`], { cwd }).split('\n').filter(Boolean),
    stat: git(['diff', '--no-color', '--stat', `${base}...${head}`], { cwd }),
    patch: patch + '\n',
  };
  const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify(record) });
  const ref = refOf(record.id);
  git(['update-ref', ref, blob], { cwd });
  if (remote) git(['push', remote, `${ref}:${ref}`], { cwd });
  return record;
}

function readLocal(id, cwd) {
  const sha = run(['rev-parse', '--verify', '-q', refOf(id)], { cwd });
  if (!sha.ok) return null;
  const blob = sha.out.trim();
  return { blob, record: JSON.parse(git(['cat-file', 'blob', blob], { cwd })) };
}

export function listLocalPrs(cwd) {
  const r = run(['for-each-ref', '--format=%(refname)', PREFIX], { cwd });
  return r.out.split('\n').filter(Boolean).map((ref) => readLocal(ref.slice(PREFIX.length), cwd)?.record).filter(Boolean);
}

export function listRemotePrIds(remote, cwd) {
  const r = run(['ls-remote', remote, `${PREFIX}*`], { cwd });
  if (!r.ok) throw new Error(`could not reach ${remote}: ${r.err}`);
  return r.out.split('\n').filter(Boolean).map((l) => l.split('\t')[1].slice(PREFIX.length));
}

/**
 * Open a PR exactly once. The burn happens *before* the contents are returned, and on a
 * remote it is the atomic step: whoever's `push --delete` succeeds owns the only copy.
 * Throws if the PR is gone. Returns { record, expired }.
 */
export function openPr(id, { cwd, remote }) {
  const ref = refOf(id);
  let local = readLocal(id, cwd);
  if (!local && remote) {
    run(['fetch', '--quiet', remote, `+${ref}:${ref}`], { cwd });
    local = readLocal(id, cwd);
  }
  if (!local) throw new Error(`PR ${id} is gone (burned, expired, or never existed)`);

  // The PR remembers where its one true copy lives, so the sender can't peek at a stale local copy either.
  const via = remote || (local.record.remote && hasRemote(local.record.remote, cwd) ? local.record.remote : null);
  if (via) {
    const onRemote = run(['ls-remote', '--exit-code', via, ref], { cwd }).ok;
    if (!onRemote || !run(['push', via, '--delete', ref], { cwd }).ok) {
      run(['update-ref', '-d', ref], { cwd });
      throw new Error(`PR ${id} was already burned`);
    }
  }
  if (!run(['update-ref', '-d', ref, local.blob], { cwd }).ok && !via) {
    throw new Error(`PR ${id} was already burned`);
  }

  return { record: local.record, expired: local.record.expiresAt <= now() };
}

/** Burn without reading (retract a PR you sent). */
export function burnPr(id, { cwd, remote }) {
  const ref = refOf(id);
  let found = false;
  if (run(['rev-parse', '-q', '--verify', ref], { cwd }).ok) {
    run(['update-ref', '-d', ref], { cwd });
    found = true;
  }
  if (remote && run(['ls-remote', '--exit-code', remote, ref], { cwd }).ok) {
    found = run(['push', remote, '--delete', ref], { cwd }).ok || found;
  }
  return found;
}

/** Delete expired local PRs. */
export function sweepPrs(cwd) {
  const burned = [];
  for (const rec of listLocalPrs(cwd)) {
    if (rec.expiresAt <= now()) {
      run(['update-ref', '-d', refOf(rec.id)], { cwd });
      burned.push(rec.id);
    }
  }
  return burned;
}
