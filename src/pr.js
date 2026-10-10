import { randomBytes } from 'node:crypto';
import { git, run, currentBranch, defaultBranch, hasRemote, branchExists } from './git.js';
import { now } from './time.js';
import { getExpiry, setExpiry } from './snaps.js';

const PR = 'refs/snapgit/pr/';
const RECEIPT = 'refs/snapgit/receipt/';
const REJECT = 'refs/snapgit/reject/';
const ID = /^[0-9a-f]{8}$/;

const check = (id) => {
  if (!ID.test(id)) throw new Error(`"${id}" is not a snapgit PR id (8 hex characters)`);
  return id;
};
const ident = (cwd) => `${run(['config', 'user.name'], { cwd }).out.trim()} <${run(['config', 'user.email'], { cwd }).out.trim()}>`;
const putBlob = (obj, cwd) => git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify(obj) });
const readRef = (ref, cwd) => {
  const sha = run(['rev-parse', '--verify', '-q', ref], { cwd });
  return sha.ok ? { blob: sha.out.trim(), data: JSON.parse(git(['cat-file', 'blob', sha.out.trim()], { cwd })) } : null;
};
/** 'present' | 'absent' | 'unreachable' */
const remoteHas = (remote, ref, cwd) => {
  const r = run(['ls-remote', '--exit-code', remote, ref], { cwd });
  return r.ok ? 'present' : r.status === 2 ? 'absent' : 'unreachable';
};
const viaFor = (record, remote, cwd) => remote || (record?.remote && hasRemote(record.remote, cwd) ? record.remote : null);

/**
 * A PR is a JSON blob under refs/snapgit/pr/<id>. It has exactly one outcome: someone rejects it, or
 * its head branch expires and it is merged. Its deadline is the branch's timer, so sending a PR
 * puts the branch on the clock.
 */
export function createPr({ cwd, head, base, message, ttlMs, remote }) {
  head ||= currentBranch(cwd);
  if (!head) throw new Error('detached HEAD: name the branch to send');
  base ||= defaultBranch(cwd);
  if (head === base) throw new Error(`${head} is the base branch: send a feature branch`);
  if (!branchExists(base, cwd)) throw new Error(`no such base branch: ${base}`);
  const patch = git(['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], { cwd });
  if (!patch) throw new Error(`${head} has no changes relative to ${base}: nothing to send`);
  let expiresAt = getExpiry(head, cwd);
  if (expiresAt === null) {
    expiresAt = now() + ttlMs;
    setExpiry(head, expiresAt, cwd);
  }
  const lines = (message || '').split('\n');
  const record = {
    v: 2,
    id: randomBytes(4).toString('hex'),
    state: 'pending',
    title: lines[0] || git(['log', '-1', '--format=%s', head], { cwd }),
    message: lines.slice(1).join('\n').trim(),
    author: ident(cwd),
    base,
    head,
    remote: remote || null,
    createdAt: now(),
    expiresAt,
    commits: git(['log', '--format=%h %s', `${base}..${head}`], { cwd }).split('\n').filter(Boolean),
    stat: git(['diff', '--no-color', '--stat', `${base}...${head}`], { cwd }),
    patch: patch + '\n',
  };
  const ref = PR + record.id;
  git(['update-ref', ref, putBlob(record, cwd)], { cwd });
  if (remote) git(['push', remote, `${ref}:${ref}`], { cwd });
  return record;
}

export function listLocalPrs(cwd) {
  const r = run(['for-each-ref', '--format=%(refname)', PR], { cwd });
  return r.out.split('\n').filter(Boolean).map((ref) => readRef(ref, cwd)?.data).filter(Boolean);
}

export function prForBranch(branch, cwd) {
  return listLocalPrs(cwd).find((r) => r.head === branch) ?? null;
}

export function listRemotePrIds(remote, cwd) {
  const r = run(['ls-remote', remote, `${PR}*`], { cwd });
  if (!r.ok) throw new Error(`could not reach ${remote}: ${r.err}`);
  return r.out.split('\n').filter(Boolean).map((l) => l.split('\t')[1].slice(PR.length));
}

/** Delete a PR (and its rejection) here and on its remote. */
function burn(id, { cwd, via }) {
  run(['update-ref', '-d', PR + id], { cwd });
  run(['update-ref', '-d', REJECT + id], { cwd });
  if (via) {
    run(['push', via, '--delete', PR + id], { cwd });
    run(['push', via, '--delete', REJECT + id], { cwd });
  }
}

/** Sender withdraws a PR: nothing merges, the branch just expires. */
export function burnPr(id, { cwd, remote }) {
  check(id);
  const rec = readRef(PR + id, cwd)?.data;
  const via = viaFor(rec, remote, cwd);
  const existed = !!rec || (via && remoteHas(via, PR + id, cwd) === 'present');
  if (existed) burn(id, { cwd, via });
  return !!existed;
}

/**
 * Read a PR. The contents can be read exactly once: the first opener claims a receipt ref (a create-only
 * push, so only one racer wins), then the PR is rewritten without its contents. The PR itself stays
 * alive. It can still be rejected, and it will still merge.
 */
export function openPr(id, { cwd, remote, screenshot = false }) {
  check(id);
  const ref = PR + id;
  const via = viaFor(readRef(ref, cwd)?.data, remote, cwd);
  if (via) {
    const where = remoteHas(via, ref, cwd);
    if (where === 'unreachable') throw new Error(`could not reach ${via}`);
    if (where === 'absent') {
      run(['update-ref', '-d', ref], { cwd });
      throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, or never existed)`);
    }
    run(['fetch', '--quiet', via, `+${ref}:${ref}`], { cwd });
  }
  const found = readRef(ref, cwd);
  if (!found) throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, or never existed)`);
  const record = found.data;
  if (record.state === 'opened') {
    throw new Error(`PR ${id} was already opened and its contents are burned. It is still live: it merges ${deadline(record)} unless rejected`);
  }
  if (record.expiresAt <= now()) throw new Error(`PR ${id} is past its deadline and about to merge. Too late to read it`);

  const receipt = { id, title: record.title, sender: record.author, opener: ident(cwd), openedAt: now(), screenshot };
  const rref = RECEIPT + id;
  if (run(['rev-parse', '-q', '--verify', rref], { cwd }).ok) throw new Error(`PR ${id} was opened by someone else a moment ago`);
  git(['update-ref', rref, putBlob(receipt, cwd)], { cwd });
  if (via && !run(['push', via, `${rref}:${rref}`], { cwd }).ok) {
    run(['update-ref', '-d', rref], { cwd });
    throw new Error(`PR ${id} was opened by someone else a moment ago`);
  }

  const redacted = { ...record, state: 'opened', message: '', commits: [], stat: '', patch: '' };
  git(['update-ref', ref, putBlob(redacted, cwd)], { cwd });
  if (via) run(['push', '--force', via, `${ref}:${ref}`], { cwd });
  if (!branchExists(record.head, cwd)) run(['update-ref', '-d', ref], { cwd }); // a recipient keeps nothing
  return { record };
}

export const deadline = (record) => `${new Date(record.expiresAt).toISOString().replace('T', ' ').slice(0, 16)}Z`;

/** Reject a PR. This is the only thing a recipient can do besides nothing. */
export function rejectPr(id, { cwd, remote, reason = '' }) {
  check(id);
  const local = readRef(PR + id, cwd)?.data;
  const via = viaFor(local, remote, cwd);
  if (via) {
    const where = remoteHas(via, PR + id, cwd);
    if (where === 'unreachable') throw new Error(`could not reach ${via}`);
    if (where === 'absent') throw new Error(`PR ${id} is gone: it already merged, was rejected, or never existed`);
  } else if (!local) {
    throw new Error(`PR ${id} not found (use --remote to reject one on a remote)`);
  }
  const rec = { id, rejector: ident(cwd), rejectedAt: now(), reason };
  const ref = REJECT + id;
  git(['update-ref', ref, putBlob(rec, cwd)], { cwd });
  if (via && !run(['push', via, `${ref}:${ref}`], { cwd }).ok) throw new Error(`PR ${id} was already rejected`);
  return rec;
}

/** Collect (and burn) opened-receipts for PRs I sent, and refresh my copies to the burned version. */
export function collectReceipts({ cwd, remote }) {
  if (remote) run(['fetch', '--quiet', remote, `+${RECEIPT}*:${RECEIPT}*`], { cwd });
  const me = ident(cwd);
  const mine = [];
  const refs = run(['for-each-ref', '--format=%(refname) %(objectname)', RECEIPT], { cwd }).out.split('\n').filter(Boolean);
  for (const line of refs) {
    const [ref, blob] = line.split(' ');
    const receipt = JSON.parse(git(['cat-file', 'blob', blob], { cwd }));
    if (receipt.sender !== me) {
      if (remote) run(['update-ref', '-d', ref], { cwd }); // only my local copy; the owner still has theirs
      continue;
    }
    mine.push(receipt);
    run(['update-ref', '-d', ref], { cwd });
    if (remote) run(['push', remote, '--delete', ref], { cwd });
    if (remote && readRef(PR + receipt.id, cwd)) run(['fetch', '--quiet', remote, `+${PR + receipt.id}:${PR + receipt.id}`], { cwd });
  }
  return mine.sort((a, b) => a.openedAt - b.openedAt);
}

/** Keep the PR's advertised deadline in step when its branch gets more time. */
export function retimePr(branch, expiresAt, cwd) {
  const rec = prForBranch(branch, cwd);
  if (!rec) return;
  const ref = PR + rec.id;
  git(['update-ref', ref, putBlob({ ...rec, expiresAt }, cwd)], { cwd });
  const via = viaFor(rec, undefined, cwd);
  if (via) run(['push', '--force', via, `${ref}:${ref}`], { cwd });
}

function worktreeOf(branch, cwd) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd });
  let path = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** Merge head into base without anyone's approval. Returns { ok } or { ok: false, reason }. */
function mergeInto(rec, cwd) {
  const { head, base } = rec;
  if (!branchExists(base, cwd)) return { ok: false, reason: `base branch ${base} no longer exists` };
  if (run(['merge-base', '--is-ancestor', head, base], { cwd }).ok) return { ok: true, note: 'already in base' };
  const msg = `Merge ${head} into ${base}\n\nsnapgit: PR ${rec.id} "${rec.title}" was not rejected before ${head} expired.`;
  const where = worktreeOf(base, cwd);
  if (where) {
    if (where !== git(['rev-parse', '--show-toplevel'], { cwd })) return { ok: false, reason: `${base} is checked out in another worktree` };
    if (run(['status', '--porcelain'], { cwd }).out.trim()) return { ok: false, reason: `${base} is checked out with uncommitted changes; commit or stash and the merge will land` };
    const m = run(['merge', '--no-ff', '--no-edit', '-m', msg, head], { cwd });
    if (!m.ok) {
      run(['merge', '--abort'], { cwd });
      return { ok: false, reason: `merge conflict between ${head} and ${base}; resolve it by hand` };
    }
    return { ok: true };
  }
  const tree = run(['merge-tree', '--write-tree', base, head], { cwd });
  if (!tree.ok) return { ok: false, reason: `merge conflict between ${head} and ${base}; resolve it by hand` };
  const oldBase = git(['rev-parse', `refs/heads/${base}`], { cwd });
  const commit = git(['commit-tree', tree.out.split('\n')[0], '-p', base, '-p', head, '-m', msg], { cwd });
  git(['update-ref', '-m', `snapgit: merge ${head}`, `refs/heads/${base}`, commit, oldBase], { cwd });
  return { ok: true };
}

/**
 * Called when a branch's timer runs out. If it has a PR: honor a rejection that arrived in time,
 * otherwise merge. Never destroys the branch on doubt (returns action 'hold').
 * Returns { action: 'none' | 'merged' | 'rejected' | 'hold', ... }.
 */
export function resolveBranchPr(branch, { cwd, push = false }) {
  const rec = prForBranch(branch, cwd);
  if (!rec) return { action: 'none' };
  const expiry = getExpiry(branch, cwd) ?? rec.expiresAt;
  const via = viaFor(rec, undefined, cwd);
  const rref = REJECT + rec.id;
  if (via) {
    const where = remoteHas(via, rref, cwd);
    if (where === 'unreachable') return { action: 'hold', id: rec.id, reason: `cannot reach ${via} to check for a rejection, so no merge yet` };
    if (where === 'present') run(['fetch', '--quiet', via, `+${rref}:${rref}`], { cwd });
  }
  const rejection = readRef(rref, cwd)?.data;
  if (rejection && rejection.rejectedAt <= expiry) {
    burn(rec.id, { cwd, via });
    return { action: 'rejected', id: rec.id, by: rejection.rejector, reason: rejection.reason };
  }
  const merged = mergeInto(rec, cwd);
  if (!merged.ok) return { action: 'hold', id: rec.id, reason: merged.reason };
  let pushed = false;
  if (push && via) pushed = run(['push', via, rec.base], { cwd }).ok;
  burn(rec.id, { cwd, via });
  return { action: 'merged', id: rec.id, base: rec.base, late: !!rejection, pushed };
}

/** PRs whose branch has vanished (deleted by hand) have nothing left to merge: burn them. */
export function sweepPrs(cwd) {
  const burned = [];
  for (const rec of listLocalPrs(cwd)) {
    if (!branchExists(rec.head, cwd) && rec.author === ident(cwd)) {
      burn(rec.id, { cwd, via: viaFor(rec, undefined, cwd) });
      burned.push(rec.id);
    }
  }
  return burned;
}
