import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, run, currentBranch, defaultBranch, hasRemote, branchExists } from './git.js';
import { now, formatDuration } from './time.js';
import { getExpiry, setExpiry, defaultTtlMs } from './snaps.js';
import { loadChecks, runChecks } from './checks.js';
import { loadPolicy } from './policy.js';
import { fuseFromFiles, gatherFiles } from './fuse.js';
import { matchesAny } from './glob.js';
import { ident, isReviewer, resolveReviewers } from './authz.js';
import { authorsOf, shameRecord } from './shame.js';
import { emit } from './notify.js';
import { publishTimer } from './timers.js';

const PR = 'refs/snapgit/pr/';
const RECEIPT = 'refs/snapgit/receipt/';
const REJECT = 'refs/snapgit/reject/';
const APPROVE = 'refs/snapgit/approve/';
const SHAME_REF = 'refs/snapgit/shame/';
const MERGED = 'refs/snapgit/merged/';
const ID = /^[0-9a-f]{8}$/;

const check = (id) => {
  if (!ID.test(id)) throw new Error(`"${id}" is not a snapgit PR id (8 hex characters)`);
  return id;
};
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

/** Local git config can override the policy's fuse numbers; SNAPGIT_FUSE_MS pins the fuse outright (tests, demos). */
function fuseOverrides(cwd) {
  const out = {};
  for (const [key, field] of [['fuseBaseSec', 'baseSec'], ['fuseSecPerLine', 'secPerLine'], ['fuseMinSec', 'minSec'], ['fuseMaxSec', 'maxSec']]) {
    const r = run(['config', `snapgit.${key}`], { cwd });
    const n = Number(r.out.trim());
    if (r.ok && r.out.trim() && Number.isFinite(n) && n >= 0) out[field] = n;
  }
  return out;
}

/** A PR's own fuse. PRs created before fuses scaled have none stored and keep the old flat minute. */
export const fuseOf = (record) => record.fuseMs ?? 60_000;

/**
 * Who may review this PR's base branch. Returns { reviewers (null = anyone), error }.
 * Read from the base branch's snapgit.json; a recipient without that branch locally can't be checked
 * (the sender still enforces it when settling).
 */
function reviewersFor(rec, cwd) {
  if (!branchExists(rec.base, cwd)) return { reviewers: null, policy: null };
  const policy = loadPolicy(rec.base, cwd);
  return { reviewers: resolveReviewers(policy, rec.base, cwd), policy };
}

/**
 * A PR is a JSON blob under refs/snapgit/pr/<id>. It has exactly one outcome: someone rejects it, or it
 * merges one fuse (sized to the change) after somebody first opens it. If nobody ever opens it, the PR is
 * deleted when its branch expires: nothing merges on a timer alone. Sending a PR puts the branch on the clock.
 */
export function createPr({ cwd, head, base, message, ttlMs, remote }) {
  head ||= currentBranch(cwd);
  if (!head) throw new Error('detached HEAD: name the branch to send');
  base ||= defaultBranch(cwd);
  if (head === base) throw new Error(`${head} is the base branch: send a feature branch`);
  if (!branchExists(base, cwd)) throw new Error(`no such base branch: ${base}`);
  const patch = git(['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], { cwd });
  if (!patch) throw new Error(`${head} has no changes relative to ${base}: nothing to send`);
  const policy = loadPolicy(base, cwd);
  const files = gatherFiles(base, head, cwd);
  const sized = fuseFromFiles(files, policy.fuse, fuseOverrides(cwd));
  const protectedFiles = files.map((f) => f.path).filter((p) => matchesAny(p, policy.protectedPaths));

  let expiresAt = getExpiry(head, cwd);
  if (expiresAt !== null && ttlMs) throw new Error(`${head} already has a timer, and timers can never be changed`);
  if (expiresAt === null) {
    expiresAt = now() + (ttlMs ?? defaultTtlMs(cwd));
    setExpiry(head, expiresAt, cwd);
  }
  const text = (message || '').split('\n');
  const record = {
    v: 3,
    id: randomBytes(4).toString('hex'),
    title: text[0] || git(['log', '-1', '--format=%s', head], { cwd }),
    message: text.slice(1).join('\n').trim(),
    author: ident(cwd),
    base,
    head,
    remote: remote || null,
    createdAt: now(),
    expiresAt,
    lines: sized.lines,
    rawLines: sized.rawLines,
    ignoredLines: sized.ignoredLines,
    fuseMs: process.env.SNAPGIT_FUSE_MS ? Number(process.env.SNAPGIT_FUSE_MS) : sized.fuseMs,
    protected: protectedFiles.length > 0,
    protectedFiles: protectedFiles.slice(0, 10),
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
    const warnings = emit('shamed', { ...shame, text: `😬 ${shame.message}` }, cwd);
    setExpiry(head, now(), cwd); // self-destruct: the next sweep deletes the branch
    return { pr: null, shame, warnings };
  }
  const ref = PR + record.id;
  git(['update-ref', ref, putBlob(record, cwd)], { cwd });
  if (remote) {
    git(['push', remote, `${ref}:${ref}`], { cwd });
    publishTimer(head, expiresAt, remote, cwd);
  }
  const warnings = emit('sent', {
    id: record.id, head, base, title: record.title, lines: record.lines, fuseMs: record.fuseMs, protected: record.protected,
    text: `📨 ${record.author} sent PR ${record.id} "${record.title}" (${record.head} -> ${base}): ${record.lines} changed lines, ${formatDuration(record.fuseMs)} fuse${record.protected ? ', touches protected paths' : ''}`,
  }, cwd);
  return { pr: record, ran: gate.checks, sized, warnings };
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

/** Head branches of every PR live on a remote, so a clock-only sweeper leaves them to their PRs. */
export function remotePrHeads(remote, cwd) {
  const scratch = 'refs/snapgit-remote/pr/';
  if (!run(['fetch', '--quiet', remote, `+${PR}*:${scratch}*`], { cwd }).ok) return new Set();
  const refs = run(['for-each-ref', '--format=%(refname)', scratch], { cwd }).out.split('\n').filter(Boolean);
  const heads = new Set();
  for (const ref of refs) {
    try { heads.add(readRef(ref, cwd).data.head); } finally { run(['update-ref', '-d', ref], { cwd }); }
  }
  return heads;
}

/** Delete a PR and everything hanging off it, here and on its remote. */
function burn(id, { cwd, via }) {
  const refs = [PR, REJECT, RECEIPT, APPROVE];
  for (const r of refs) run(['update-ref', '-d', r + id], { cwd });
  if (via) for (const r of refs) run(['push', via, '--delete', r + id], { cwd });
  for (const tag of ['half', 'held']) run(['config', '--unset', `snapgit.once.k${id}${tag}`], { cwd });
}

/** True the first time for a (key, value) pair: keeps a watcher from announcing the same thing every few seconds. */
function once(id, tag, value, cwd) {
  const key = `snapgit.once.k${id}${tag}`;
  const seen = run(['config', key], { cwd });
  if (seen.ok && seen.out.trim() === String(value)) return false;
  git(['config', key, String(value)], { cwd });
  return true;
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
 * Open a PR. The first (authorized) opener claims a receipt ref (a create-only push, so only one racer wins)
 * and that starts the fuse. The opener may re-read the changed code until it burns out; nobody else may.
 * When the policy names reviewers, only they can open; you can't review your own PR; and a receipt left by
 * someone who is not a reviewer is treated as squatting and replaced.
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
      throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, expired, or never existed)`);
    }
    run(['fetch', '--quiet', via, `+${ref}:${ref}`], { cwd });
    if (remoteHas(via, rref, cwd) === 'present') run(['fetch', '--quiet', via, `+${rref}:${rref}`], { cwd });
  }
  const found = readRef(ref, cwd);
  if (!found) throw new Error(`PR ${id} is gone (merged, rejected, withdrawn, expired, or never existed)`);
  const record = found.data;
  const me = ident(cwd);
  const { reviewers } = reviewersFor(record, cwd);
  if (reviewers) {
    if (!isReviewer(me, reviewers)) throw new Error(`you are not a reviewer here (reviewers: ${reviewers.join(', ')})`);
    if (me === record.author) throw new Error('you cannot review your own PR');
  }

  let receipt = readRef(rref, cwd)?.data;
  let squatted = false;
  if (receipt && reviewers && !isReviewer(receipt.opener, reviewers)) { receipt = null; squatted = true; }
  if (receipt) {
    if (receipt.opener !== me) throw new Error(`PR ${id} is already being reviewed by ${receipt.opener}`);
    if (receipt.openedAt + fuseOf(record) <= now()) throw new Error(`PR ${id}: the fuse burned out. It is merging`);
  } else {
    if (record.expiresAt <= now()) throw new Error(`PR ${id} is past its deadline and is about to be deleted. Too late to open it`);
    receipt = { id, title: record.title, sender: record.author, opener: me, openedAt: now(), screenshot };
    git(['update-ref', rref, putBlob(receipt, cwd)], { cwd });
    if (via && !run(['push', ...(squatted ? ['--force'] : []), via, `${rref}:${rref}`], { cwd }).ok) {
      run(['update-ref', '-d', rref], { cwd });
      throw new Error(`PR ${id} was opened by someone else a moment ago`);
    }
    emit('opened', { id, head: record.head, title: record.title, opener: me, fuseMs: fuseOf(record), text: `🔥 ${me} opened PR ${id} "${record.title}": ${formatDuration(fuseOf(record))} fuse is lit` }, cwd);
  }
  if (!branchExists(record.head, cwd)) {
    run(['update-ref', '-d', ref], { cwd }); // a recipient keeps nothing; re-open fetches it again
    if (via) run(['update-ref', '-d', rref], { cwd });
  }
  return { record, receipt, mergesAt: Math.min(record.expiresAt, receipt.openedAt + fuseOf(record)) };
}

export const deadline = (record) => `${new Date(record.expiresAt).toISOString().replace('T', ' ').slice(0, 16)}Z`;

/** Fetch a PR's record from wherever it lives (without claiming it). Throws if it is gone. */
function findPr(id, { cwd, remote }) {
  const local = readRef(PR + id, cwd)?.data;
  const via = viaFor(local, remote, cwd);
  if (via) {
    const where = remoteHas(via, PR + id, cwd);
    if (where === 'unreachable') throw new Error(`could not reach ${via}`);
    if (where === 'absent') throw new Error(`PR ${id} is gone: it already merged, was rejected, expired, or never existed`);
    return { record: local, via };
  }
  if (!local) throw new Error(`PR ${id} not found (use --remote to act on one that lives on a remote)`);
  return { record: local, via: null };
}

/** Reject a PR. This is the only thing a recipient can do besides nothing. */
export function rejectPr(id, { cwd, remote, reason = '' }) {
  check(id);
  const { record, via } = findPr(id, { cwd, remote });
  const me = ident(cwd);
  if (record) {
    const { reviewers } = reviewersFor(record, cwd);
    if (reviewers && !isReviewer(me, reviewers)) throw new Error(`you are not a reviewer here (reviewers: ${reviewers.join(', ')})`);
  }
  const rec = { id, rejector: me, rejectedAt: now(), reason };
  const ref = REJECT + id;
  git(['update-ref', ref, putBlob(rec, cwd)], { cwd });
  if (via && !run(['push', via, `${ref}:${ref}`], { cwd }).ok) throw new Error(`PR ${id} was already rejected`);
  return rec;
}

/**
 * Approve a PR that touches protectedPaths. This is the one exception to "there is no approve": those PRs
 * will not merge by silence, they need a reviewer to say yes. (Everything else merges unless rejected.)
 */
export function approvePr(id, { cwd, remote }) {
  check(id);
  const { via } = findPr(id, { cwd, remote });
  let record = readRef(PR + id, cwd)?.data;
  if (!record && via) {
    run(['fetch', '--quiet', via, `+${PR + id}:${PR + id}`], { cwd });
    record = readRef(PR + id, cwd)?.data;
    if (record && !branchExists(record.head, cwd)) run(['update-ref', '-d', PR + id], { cwd });
  }
  if (!record) throw new Error(`PR ${id} not found`);
  if (!record.protected) throw new Error(`PR ${id} does not touch protected paths: it simply merges unless it is rejected`);
  const me = ident(cwd);
  const { reviewers } = reviewersFor(record, cwd);
  if (reviewers ? !isReviewer(me, reviewers) : me === record.author) {
    throw new Error(reviewers ? `you are not a reviewer here (reviewers: ${reviewers.join(', ')})` : 'you cannot approve your own PR');
  }
  const approval = { id, approver: me, approvedAt: now() };
  const ref = APPROVE + id;
  git(['update-ref', ref, putBlob(approval, cwd)], { cwd });
  if (via && !run(['push', '--force', via, `${ref}:${ref}`], { cwd }).ok) throw new Error(`could not publish the approval to ${via}`);
  return approval;
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

/** Can the base branch be moved right now? Returns a reason string if not. */
function baseBlocked(base, cwd) {
  const where = worktreeOf(base, cwd);
  if (!where) return { where: null };
  if (where !== git(['rev-parse', '--show-toplevel'], { cwd })) return { reason: `${base} is checked out in another worktree` };
  if (run(['status', '--porcelain'], { cwd }).out.trim()) return { reason: `${base} is checked out with uncommitted changes; commit or stash and the merge will land` };
  return { where };
}

/** Move `base` to `commit`: a fast-forward in the checked-out worktree, or a plain ref update otherwise. */
function advance(base, commit, oldTip, where, cwd) {
  if (where) {
    const m = run(['merge', '--ff-only', '--quiet', commit], { cwd });
    return m.ok ? null : `could not fast-forward ${base}: ${m.err.split('\n')[0]}`;
  }
  git(['update-ref', '-m', `snapgit: ${base} -> ${commit.slice(0, 7)}`, `refs/heads/${base}`, commit, oldTip], { cwd });
  return null;
}

/**
 * Build the merge of head into base as a commit (without moving any branch), run the base branch's CI
 * checks against it in a throwaway worktree, and only then move base. Returns { ok: true, commit } |
 * { ok: false, reason } (hold: nothing happened) | { ok: false, ci: failure } (checks failed).
 */
function mergeInto(rec, cwd) {
  const { head, base } = rec;
  if (!branchExists(base, cwd)) return { ok: false, reason: `base branch ${base} no longer exists` };
  if (run(['merge-base', '--is-ancestor', head, base], { cwd }).ok) return { ok: true, note: 'already in base' };

  const blocked = baseBlocked(base, cwd);
  if (blocked.reason) return { ok: false, reason: blocked.reason };
  const built = buildMerge(rec, cwd);
  if (!built.ok) return built;

  let checks;
  try { checks = loadChecks(base, cwd); } catch (e) { return { ok: false, reason: e.message }; }
  if (checks.length) {
    const ci = runChecks(built.commit, checks, { cwd, env: { SNAPGIT_PR: rec.id, SNAPGIT_HEAD: head, SNAPGIT_BASE: base } });
    if (!ci.ok) return { ok: false, ci: ci.results[ci.results.length - 1], results: ci.results };
  }
  const failure = advance(base, built.commit, built.oldBase, blocked.where, cwd);
  if (failure) return { ok: false, reason: failure };
  return { ok: true, ran: checks.length, commit: built.commit, oldBase: built.oldBase };
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

/** Everything merged here, newest first (this is the ledger `undo` works from). */
export function listMerged(cwd) {
  const refs = run(['for-each-ref', '--format=%(refname)', MERGED], { cwd }).out.split('\n').filter(Boolean);
  return refs.map((r) => readRef(r, cwd)?.data).filter(Boolean).sort((a, b) => b.mergedAt - a.mergedAt);
}

/**
 * Settle every PR that is due. A PR is due when its fuse burns out (opened + its fuse) or when its branch
 * timer does, whichever is first, and:
 *   - never opened by an authorized reviewer: it is deleted. Nothing merges on a timer alone.
 *   - rejected in time by an authorized reviewer: it is dropped.
 *   - touching protectedPaths without a reviewer's approval: held (and deleted when the branch expires).
 *   - failing the base branch's CI checks: not merged, the authors are shamed, the branch self-destructs.
 *   - otherwise: merged, and the merge is written to the ledger so `undo` can reverse it.
 * Doubt never destroys work: anything that can't be merged or verified is held. With offline, PRs that live
 * on a remote are left alone. Returns { events, gone: Set<branch> (delete now), held: Map<branch, reason> }.
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
    const aref = APPROVE + rec.id;
    const unreachable = () => held.set(rec.head, `cannot reach ${via} to check for a rejection, so no merge yet`);

    let who;
    try { who = reviewersFor(rec, cwd); } catch (e) { held.set(rec.head, e.message); events.push({ action: 'hold', id: rec.id, head: rec.head, reason: e.message }); continue; }
    const { reviewers } = who;

    if (via) {
      const r = remoteHas(via, cref, cwd);
      if (r === 'unreachable') { if (expiry <= now()) unreachable(); continue; }
      if (r === 'present') run(['fetch', '--quiet', via, `+${cref}:${cref}`], { cwd });
    }
    let receipt = readRef(cref, cwd)?.data ?? null;
    if (receipt && reviewers && !isReviewer(receipt.opener, reviewers)) receipt = null; // squatter: not a real opening
    const due = Math.min(expiry, receipt ? receipt.openedAt + fuseOf(rec) : Infinity);

    if (receipt && due > now() && now() >= receipt.openedAt + fuseOf(rec) / 2 && once(rec.id, 'half', 1, cwd)) {
      emit('halfway', { id: rec.id, head: rec.head, title: rec.title, text: `⏳ PR ${rec.id} "${rec.title}": half the fuse is gone, ${formatDuration(due - now())} left to reject it` }, cwd);
    }
    if (due > now()) continue;

    if (via) {
      const r = remoteHas(via, rref, cwd);
      if (r === 'unreachable') { unreachable(); continue; }
      if (r === 'present') run(['fetch', '--quiet', via, `+${rref}:${rref}`], { cwd });
    }
    let rejection = readRef(rref, cwd)?.data ?? null;
    if (rejection && reviewers && !isReviewer(rejection.rejector, reviewers)) rejection = null;
    if (rejection && rejection.rejectedAt <= due) {
      burn(rec.id, { cwd, via });
      events.push({ action: 'rejected', id: rec.id, head: rec.head, by: rejection.rejector, reason: rejection.reason });
      emit('rejected', { id: rec.id, head: rec.head, title: rec.title, by: rejection.rejector, reason: rejection.reason, text: `🚫 PR ${rec.id} "${rec.title}" rejected by ${rejection.rejector}${rejection.reason ? `: "${rejection.reason}"` : ''}` }, cwd);
      continue;
    }
    if (!receipt) {
      burn(rec.id, { cwd, via });
      events.push({ action: 'expired', id: rec.id, head: rec.head });
      emit('expired', { id: rec.id, head: rec.head, title: rec.title, text: `💨 PR ${rec.id} "${rec.title}" expired unopened, so it was deleted. Nobody looked, so nothing merged` }, cwd);
      continue;
    }

    if (rec.protected) {
      if (via && remoteHas(via, aref, cwd) === 'present') run(['fetch', '--quiet', via, `+${aref}:${aref}`], { cwd });
      const approval = readRef(aref, cwd)?.data;
      const approved = approval && (reviewers ? isReviewer(approval.approver, reviewers) : approval.approver !== rec.author);
      if (!approved && expiry <= now()) {
        // Nobody vouched for a protected change before its branch expired: it dies with the branch.
        burn(rec.id, { cwd, via });
        events.push({ action: 'expired', id: rec.id, head: rec.head, reason: 'never approved' });
        emit('expired', { id: rec.id, head: rec.head, title: rec.title, text: `💨 PR ${rec.id} "${rec.title}" touches protected paths and was never approved, so it was deleted with its branch` }, cwd);
        continue;
      }
      if (!approved) {
        const reason = `touches protected paths (${rec.protectedFiles.slice(0, 3).join(', ')}${rec.protectedFiles.length > 3 ? ', ...' : ''}): needs snapgit pr approve ${rec.id} from a reviewer`;
        held.set(rec.head, reason);
        events.push({ action: 'hold', id: rec.id, head: rec.head, reason });
        if (once(rec.id, 'held', 'protected', cwd)) emit('held', { id: rec.id, head: rec.head, title: rec.title, reason, text: `✋ PR ${rec.id} "${rec.title}" ${reason}` }, cwd);
        continue;
      }
    }

    const result = mergeInto(rec, cwd);
    if (!result.ok && result.ci) {
      const record = shameRecord({ rec, failure: result.ci, authors: authorsOf(rec.base, rec.head, cwd) });
      git(['update-ref', SHAME_REF + rec.id, putBlob(record, cwd)], { cwd });
      if (via) run(['push', '--force', via, `${SHAME_REF + rec.id}:${SHAME_REF + rec.id}`], { cwd });
      const warnings = emit('shamed', { ...record, text: `😬 ${record.message}` }, cwd);
      burn(rec.id, { cwd, via });
      gone.add(rec.head);
      events.push({ action: 'shamed', id: rec.id, head: rec.head, record, warnings });
      continue;
    }
    if (!result.ok) {
      held.set(rec.head, result.reason);
      events.push({ action: 'hold', id: rec.id, head: rec.head, reason: result.reason });
      if (once(rec.id, 'held', result.reason, cwd)) emit('held', { id: rec.id, head: rec.head, title: rec.title, reason: result.reason, text: `✋ PR ${rec.id} "${rec.title}" is held: ${result.reason}` }, cwd);
      continue;
    }
    const pushed = push && via ? run(['push', via, rec.base], { cwd }).ok : false;
    if (result.commit) {
      git(['update-ref', MERGED + rec.id, putBlob({
        id: rec.id, title: rec.title, head: rec.head, base: rec.base, mergeCommit: result.commit, preBase: result.oldBase,
        headSha: git(['rev-parse', `refs/heads/${rec.head}`], { cwd }), mergedAt: now(), opener: receipt.opener,
      }, cwd)], { cwd });
    }
    burn(rec.id, { cwd, via });
    gone.add(rec.head);
    events.push({ action: 'merged', id: rec.id, head: rec.head, base: rec.base, late: !!rejection, pushed, viewed: true, checks: result.ran ?? 0 });
    emit('merged', { id: rec.id, head: rec.head, base: rec.base, title: rec.title, text: `🔀 PR ${rec.id} "${rec.title}" merged into ${rec.base}${result.ran ? ` (${result.ran} CI check${result.ran > 1 ? 's' : ''} passed)` : ''}. Undo with: snapgit undo ${rec.id}` }, cwd);
  }
  return { events, gone, held };
}

/**
 * Reverse a merge snapgit made: a revert commit on top of the base branch (history is never rewritten).
 * Works from the ledger, so it runs where the merge ran. The branch can be brought back from the graveyard.
 */
export function undoPr(id, { cwd, remote, push = false }) {
  check(id);
  const led = readRef(MERGED + id, cwd)?.data;
  if (!led) throw new Error(`PR ${id} has no merge on record here (undo works on the machine that merged it; see: snapgit merged)`);
  if (led.undoneAt) throw new Error(`PR ${id} was already undone`);
  const { base, mergeCommit } = led;
  if (!branchExists(base, cwd)) throw new Error(`base branch ${base} no longer exists`);
  if (!run(['merge-base', '--is-ancestor', mergeCommit, base], { cwd }).ok) throw new Error(`the merge commit is no longer part of ${base}`);
  const blocked = baseBlocked(base, cwd);
  if (blocked.reason) throw new Error(blocked.reason);

  const oldTip = git(['rev-parse', `refs/heads/${base}`], { cwd });
  const dir = mkdtempSync(join(tmpdir(), 'snapgit-undo-'));
  git(['worktree', 'add', '--quiet', '--detach', dir, oldTip], { cwd });
  let revert;
  try {
    const r = run(['revert', '-m', '1', '--no-edit', mergeCommit], { cwd: dir });
    if (!r.ok) {
      run(['revert', '--abort'], { cwd: dir });
      throw new Error(`reverting ${mergeCommit.slice(0, 7)} conflicts with later changes on ${base}; revert it by hand`);
    }
    revert = git(['rev-parse', 'HEAD'], { cwd: dir });
  } finally {
    run(['worktree', 'remove', '--force', dir], { cwd });
  }
  const failure = advance(base, revert, oldTip, blocked.where, cwd);
  if (failure) throw new Error(failure);
  git(['update-ref', MERGED + id, putBlob({ ...led, undoneAt: now(), revertCommit: revert }, cwd)], { cwd });
  const via = remote || null;
  const pushed = push && via ? run(['push', via, base], { cwd }).ok : false;
  emit('undone', { id, base, title: led.title, text: `↩️ PR ${id} "${led.title}" was undone: ${base} has a revert commit on top` }, cwd);
  return { revert: revert.slice(0, 7), base, head: led.head, pushed };
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
