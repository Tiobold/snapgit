import { randomBytes } from 'node:crypto';
import { git, run, currentBranch, defaultBranch, hasRemote, branchExists } from './git.js';
import { now } from './time.js';
import { getExpiry, setExpiry, defaultTtlMs } from './snaps.js';
import { loadChecks, runChecks } from './checks.js';
import { authorsOf, shameRecord, notify } from './shame.js';

const PR = 'refs/snapgit/pr/';
const RECEIPT = 'refs/snapgit/receipt/';
const REJECT = 'refs/snapgit/reject/';
const SHAME_REF = 'refs/snapgit/shame/';
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

/** How long a reviewer has to reject once they have opened a PR. SNAPGIT_FUSE_MS overrides (tests, demos). */
export const fuseMs = () => Number(process.env.SNAPGIT_FUSE_MS || 60_000);

/**
 * A PR is a JSON blob under refs/snapgit/pr/<id>. It has exactly one outcome: someone rejects it, or
 * it merges. It merges fuseMs after somebody first opens it, or when its head branch expires,
 * whichever comes first. Sending a PR puts the branch on the clock.
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
  if (expiresAt !== null && ttlMs) throw new Error(`${head} already has a timer, and timers can never be changed`);
  if (expiresAt === null) {
    expiresAt = now() + (ttlMs ?? defaultTtlMs(cwd));
    setExpiry(head, expiresAt, cwd);
  }
  const lines = (message || '').split('\n');
  const record = {
    v: 2,
    id: randomBytes(4).toString('hex'),
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
  // Fail fast: run the base branch's CI checks on the would-be merge before anyone is asked to review it.
  const gate = previewChecks(record, { cwd });
  if (!gate.ok) {
    const failure = gate.results[gate.results.length - 1];
    const shame = shameRecord({ rec: record, failure, authors: authorsOf(base, head, cwd) });
    git(['update-ref', SHAME_REF + record.id, putBlob(shame, cwd)], { cwd });
    if (remote) run(['push', '--force', remote, `${SHAME_REF + record.id}:${SHAME_REF + record.id}`], { cwd });
    const notifyError = notify(shame, cwd);
    setExpiry(head, now(), cwd); // self-destruct: the next sweep deletes the branch
    return { pr: null, shame, notifyError };
  }
  const ref = PR + record.id;
  git(['update-ref', ref, putBlob(record, cwd)], { cwd });
  if (remote) git(['push', remote, `${ref}:${ref}`], { cwd });
  return { pr: record, ran: gate.checks };
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
  run(['update-ref', '-d', RECEIPT + id], { cwd });
  if (via) {
    for (const r of [PR, REJECT, RECEIPT]) run(['push', via, '--delete', r + id], { cwd });
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
 * Open a PR. The first opener claims a receipt ref (a create-only push, so only one racer wins) and that
 * starts the fuse: the PR merges fuseMs later unless rejected. The opener may re-read the changed code
 * until then; nobody else may.
 */
export function openPr(id, { cwd, remote, screenshot = false }) {
  check(id);
  const ref = PR + id;
  const rref = RECEIPT + id;
  const via = viaFor(readRef(ref, cwd)?.data, remote, cwd);
  if (via) {
    const where = remoteHas(via, ref, cwd);
    if (where === 'unreachable') throw new Error(`could not reach ${via}`);
    if (where === 'absent') {
      run(['update-ref', '-d', ref], { cwd });
      throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, or never existed)`);
    }
    run(['fetch', '--quiet', via, `+${ref}:${ref}`], { cwd });
    if (remoteHas(via, rref, cwd) === 'present') run(['fetch', '--quiet', via, `+${rref}:${rref}`], { cwd });
  }
  const found = readRef(ref, cwd);
  if (!found) throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, or never existed)`);
  const record = found.data;
  const me = ident(cwd);

  let receipt = readRef(rref, cwd)?.data;
  if (receipt) {
    if (receipt.opener !== me) throw new Error(`PR ${id} is already being reviewed by ${receipt.opener}`);
    if (receipt.openedAt + fuseMs() <= now()) throw new Error(`PR ${id}: the fuse burned out. It is merging`);
  } else {
    if (record.expiresAt <= now()) throw new Error(`PR ${id} is past its deadline and about to merge. Too late to open it`);
    receipt = { id, title: record.title, sender: record.author, opener: me, openedAt: now(), screenshot };
    git(['update-ref', rref, putBlob(receipt, cwd)], { cwd });
    if (via && !run(['push', via, `${rref}:${rref}`], { cwd }).ok) {
      run(['update-ref', '-d', rref], { cwd });
      throw new Error(`PR ${id} was opened by someone else a moment ago`);
    }
  }
  if (!branchExists(record.head, cwd)) {
    run(['update-ref', '-d', ref], { cwd }); // a recipient keeps nothing; re-open fetches it again
    if (via) run(['update-ref', '-d', rref], { cwd });
  }
  return { record, receipt, mergesAt: Math.min(record.expiresAt, receipt.openedAt + fuseMs()) };
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

/** Opened-receipts for PRs I sent: who opened it, when, and whether they screenshotted. */
export function collectReceipts({ cwd, remote }) {
  if (remote) run(['fetch', '--quiet', remote, `+${RECEIPT}*:${RECEIPT}*`], { cwd });
  const me = ident(cwd);
  const mine = [];
  const refs = run(['for-each-ref', '--format=%(refname) %(objectname)', RECEIPT], { cwd }).out.split('\n').filter(Boolean);
  for (const line of refs) {
    const [ref, blob] = line.split(' ');
    const receipt = JSON.parse(git(['cat-file', 'blob', blob], { cwd }));
    if (receipt.sender === me) mine.push(receipt);
    else if (remote) run(['update-ref', '-d', ref], { cwd }); // someone else's: drop my fetched copy only
  }
  return mine.sort((a, b) => a.openedAt - b.openedAt);
}

/** The local receipt for a PR, if it has been opened. */
export const receiptFor = (id, cwd) => readRef(RECEIPT + id, cwd)?.data ?? null;

function worktreeOf(branch, cwd) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd });
  let path = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/**
 * Build the merge of head into base as a commit (without moving any branch), run the base branch's CI
 * checks against it in a throwaway worktree, and only then move base. Returns
 * { ok: true } | { ok: false, reason } (hold: nothing happened) | { ok: false, ci: failure } (checks failed).
 */
function mergeInto(rec, cwd) {
  const { head, base } = rec;
  if (!branchExists(base, cwd)) return { ok: false, reason: `base branch ${base} no longer exists` };
  if (run(['merge-base', '--is-ancestor', head, base], { cwd }).ok) return { ok: true, note: 'already in base' };

  const where = worktreeOf(base, cwd);
  if (where) {
    if (where !== git(['rev-parse', '--show-toplevel'], { cwd })) return { ok: false, reason: `${base} is checked out in another worktree` };
    if (run(['status', '--porcelain'], { cwd }).out.trim()) return { ok: false, reason: `${base} is checked out with uncommitted changes; commit or stash and the merge will land` };
  }
  const built = buildMerge(rec, cwd);
  if (!built.ok) return built;

  let checks;
  try { checks = loadChecks(base, cwd); } catch (e) { return { ok: false, reason: e.message }; }
  if (checks.length) {
    const ci = runChecks(built.commit, checks, { cwd, env: { SNAPGIT_PR: rec.id, SNAPGIT_HEAD: head, SNAPGIT_BASE: base } });
    if (!ci.ok) return { ok: false, ci: ci.results[ci.results.length - 1], results: ci.results };
  }
  if (where) {
    const m = run(['merge', '--ff-only', '--quiet', built.commit], { cwd });
    if (!m.ok) return { ok: false, reason: `could not fast-forward ${base}: ${m.err.split('\n')[0]}` };
  } else {
    git(['update-ref', '-m', `snapgit: merge ${head}`, `refs/heads/${base}`, built.commit, built.oldBase], { cwd });
  }
  return { ok: true, ran: checks.length };
}

function buildMerge(rec, cwd) {
  const { head, base } = rec;
  const msg = `Merge ${head} into ${base}\n\nsnapgit: PR ${rec.id} "${rec.title}" was not rejected in time.`;
  const tree = run(['merge-tree', '--write-tree', base, head], { cwd });
  if (!tree.ok) return { ok: false, reason: `merge conflict between ${head} and ${base}; resolve it by hand` };
  const oldBase = git(['rev-parse', `refs/heads/${base}`], { cwd });
  const commit = git(['commit-tree', tree.out.split('\n')[0], '-p', base, '-p', head, '-m', msg], { cwd });
  return { ok: true, commit, oldBase };
}

/** Run the CI checks against what the merge would produce, without merging or shaming anyone. */
export function previewChecks(idOrRecord, { cwd }) {
  let rec = idOrRecord;
  if (typeof idOrRecord === 'string') {
    check(idOrRecord);
    rec = readRef(PR + idOrRecord, cwd)?.data;
    if (!rec || !branchExists(rec.head, cwd)) throw new Error(`PR ${idOrRecord} is not on this machine: run checks where the branch lives`);
  }
  const built = buildMerge(rec, cwd);
  if (!built.ok) throw new Error(built.reason);
  const checks = loadChecks(rec.base, cwd);
  if (!checks.length) return { checks: 0, results: [], ok: true };
  const ci = runChecks(built.commit, checks, { cwd, env: { SNAPGIT_PR: rec.id, SNAPGIT_HEAD: rec.head, SNAPGIT_BASE: rec.base } });
  return { checks: checks.length, ...ci };
}

/** Shame records for PRs that failed CI (here, plus whatever a remote has). */
export function listShame({ cwd, remote }) {
  if (remote) run(['fetch', '--quiet', remote, `+${SHAME_REF}*:${SHAME_REF}*`], { cwd });
  const refs = run(['for-each-ref', '--format=%(refname)', SHAME_REF], { cwd }).out.split('\n').filter(Boolean);
  return refs.map((r) => readRef(r, cwd)?.data).filter(Boolean).sort((a, b) => a.at - b.at);
}

export function clearShame({ cwd, remote }) {
  const ids = listShame({ cwd }).map((r) => r.id);
  for (const id of ids) {
    run(['update-ref', '-d', SHAME_REF + id], { cwd });
    if (remote) run(['push', remote, '--delete', SHAME_REF + id], { cwd });
  }
  return ids.length;
}

/**
 * Settle every PR that is due: rejected ones are dropped, the rest are merged. A PR is due when its fuse
 * (opened + fuseMs) or its branch timer runs out. Doubt never destroys work: anything that can't be
 * merged or verified is reported as held. With offline, PRs that live on a remote are left alone.
 * A PR whose CI checks fail is not merged: its authors are shamed and its branch self-destructs.
 * Returns { events, gone: Set<branch> (to delete now), held: Map<branch, reason> }.
 */
export function settlePrs({ cwd, push = false, offline = false }) {
  const events = [];
  const gone = new Set();
  const held = new Map();
  for (const rec of listLocalPrs(cwd)) {
    if (!branchExists(rec.head, cwd)) continue;
    const via = viaFor(rec, undefined, cwd);
    if (via && offline) continue;
    const expiry = getExpiry(rec.head, cwd) ?? rec.expiresAt;
    const rref = REJECT + rec.id;
    const cref = RECEIPT + rec.id;
    const unreachable = () => {
      if (expiry <= now()) held.set(rec.head, `cannot reach ${via} to check for a rejection, so no merge yet`);
    };
    if (via) {
      const r = remoteHas(via, cref, cwd);
      if (r === 'unreachable') { unreachable(); continue; }
      if (r === 'present') run(['fetch', '--quiet', via, `+${cref}:${cref}`], { cwd });
    }
    const receipt = readRef(cref, cwd)?.data;
    const due = Math.min(expiry, receipt ? receipt.openedAt + fuseMs() : Infinity);
    if (due > now()) continue;

    if (via) {
      const r = remoteHas(via, rref, cwd);
      if (r === 'unreachable') { unreachable(); held.set(rec.head, `cannot reach ${via} to check for a rejection, so no merge yet`); continue; }
      if (r === 'present') run(['fetch', '--quiet', via, `+${rref}:${rref}`], { cwd });
    }
    const rejection = readRef(rref, cwd)?.data;
    if (rejection && rejection.rejectedAt <= due) {
      burn(rec.id, { cwd, via });
      events.push({ action: 'rejected', id: rec.id, head: rec.head, by: rejection.rejector, reason: rejection.reason });
      continue;
    }
    const result = mergeInto(rec, cwd);
    if (!result.ok && result.ci) {
      const record = shameRecord({ rec, failure: result.ci, authors: authorsOf(rec.base, rec.head, cwd) });
      git(['update-ref', SHAME_REF + rec.id, putBlob(record, cwd)], { cwd });
      if (via) run(['push', '--force', via, `${SHAME_REF + rec.id}:${SHAME_REF + rec.id}`], { cwd });
      const notifyError = notify(record, cwd);
      burn(rec.id, { cwd, via });
      gone.add(rec.head);
      events.push({ action: 'shamed', id: rec.id, head: rec.head, record, notifyError });
      continue;
    }
    if (!result.ok) {
      held.set(rec.head, result.reason);
      events.push({ action: 'hold', id: rec.id, head: rec.head, reason: result.reason });
      continue;
    }
    const pushed = push && via ? run(['push', via, rec.base], { cwd }).ok : false;
    burn(rec.id, { cwd, via });
    gone.add(rec.head);
    events.push({ action: 'merged', id: rec.id, head: rec.head, base: rec.base, late: !!rejection, pushed, viewed: !!receipt, checks: result.ran ?? 0 });
  }
  return { events, gone, held };
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
