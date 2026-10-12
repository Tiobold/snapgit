// snapgit rules for real GitHub PRs. Same semantics as the CLI:
//   - no approve: a reviewer lights the fuse (/snapgit open, or any submitted review) and the PR merges when it
//     burns out, unless it is rejected (/snapgit reject, or a "changes requested" review);
//   - a PR nobody ever opens is closed and its branch deleted when its lifetime (ttlHours) is up;
//   - CI (GitHub's own checks) must pass: if it fails, the authors are shamed and the branch self-destructs;
//   - protectedPaths need a reviewer's /snapgit approve; reviewers/CODEOWNERS limit who can act; frozen halts all.
// All state lives in one bot comment on the PR, so there is nothing to host.
import { parsePolicy, DEFAULT_POLICY } from '../src/policy.js';
import { fuseFromFiles } from '../src/fuse.js';
import { matchesAny } from '../src/glob.js';
import { isReviewer, parseCodeowners } from '../src/authz.js';
import { AGENT, shameMessage } from '../src/shame.js';
import { formatDuration } from '../src/time.js';

export const MARK = '<!-- snapgit-state ';
export const LABEL = { merged: 'snapgit:merged', rejected: 'snapgit:rejected', expired: 'snapgit:expired', shamed: 'snapgit:shamed' };
const identOf = (login) => `${login} <${login}@users.noreply.github.com>`;
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
const SAFE_BRANCHES = ['main', 'master', 'trunk', 'develop'];

export function createEngine({ gh, now = () => Date.now(), ignoreChecks = ['snapgit'], log = () => {} }) {
  const defaults = () => ({ ...DEFAULT_POLICY, fuse: {}, checks: [], protectedPaths: [] });

  async function policyFor(base) {
    const text = await gh.getFile('snapgit.json', base);
    return text === null ? defaults() : parsePolicy(text, base);
  }

  async function reviewersFor(policy, base) {
    if (policy.reviewers === null || policy.reviewers === undefined) return null;
    if (policy.reviewers !== 'CODEOWNERS') return policy.reviewers;
    for (const path of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
      const text = await gh.getFile(path, base);
      if (text !== null) {
        const owners = parseCodeowners(text);
        if (!owners.length) throw new Error(`${path} names no individual owners (teams cannot be resolved here: list people in snapgit.json)`);
        return owners;
      }
    }
    throw new Error('snapgit.json says reviewers is "CODEOWNERS" but there is no CODEOWNERS file');
  }

  // ---- state lives in a bot comment: <!-- snapgit-state {json} --> followed by a human-readable status
  async function load(n) {
    const comments = await gh.listComments(n);
    const c = comments.find((x) => x.user?.type === 'Bot' && x.body?.startsWith(MARK));
    if (!c) return null;
    const json = c.body.slice(MARK.length, c.body.indexOf(' -->'));
    try { return { comment: c, state: JSON.parse(json) }; } catch { return null; }
  }

  const dueOf = (s) => Math.min(s.expiresAt, s.openedAt ? s.openedAt + s.fuseMs : Infinity);

  function statusText(s, pr) {
    const sized = `${s.lines} changed line${s.lines === 1 ? '' : 's'}${s.ignoredLines ? ` (${s.ignoredLines} more in ignored files)` : ''} = a ${formatDuration(s.fuseMs)} fuse`;
    let line;
    if (s.merged) line = `🔀 Merged${s.merged.sha ? ` as \`${s.merged.sha.slice(0, 7)}\`` : ''}. Undo with \`/snapgit undo\`.`;
    else if (s.rejected) line = `🚫 Rejected by @${s.rejected.by}${s.rejected.reason ? `: ${s.rejected.reason}` : ''}. Nothing merged.`;
    else if (s.expired) line = `💨 ${s.expired}`;
    else if (s.shamed) line = '😬 Failed CI. The branch self-destructed.';
    else if (s.openedAt) {
      line = `🔥 Fuse lit by @${s.openedBy}. It merges ${iso(s.openedAt + s.fuseMs)} unless rejected (\`/snapgit reject\` or request changes).`;
      if (s.protected && !s.approvedBy) line += ` ✋ It touches protected paths, so a reviewer must also \`/snapgit approve\`.`;
    } else {
      line = `⏳ Waiting for a reviewer. Say \`/snapgit open\` (or submit a review) to light the ${formatDuration(s.fuseMs)} fuse. Nobody opens it by ${iso(s.expiresAt)}? It is deleted.`;
      if (s.protected) line += ` ✋ It touches protected paths (${s.protectedFiles.slice(0, 3).join(', ')}), so a reviewer must also \`/snapgit approve\`.`;
    }
    return `**snapgit** 👻 ${sized}\n\n${line}`;
  }

  async function write(n, loaded, state, pr) {
    const body = `${MARK}${JSON.stringify(state)} -->\n${statusText(state, pr)}`;
    if (loaded) await gh.updateComment(loaded.comment.id, body);
    else await gh.createComment(n, body);
  }

  const say = (n, text) => gh.createComment(n, text);

  async function sizeUp(pr, policy) {
    const files = await gh.listFiles(pr.number);
    const sized = fuseFromFiles(files.map((f) => ({ path: f.filename, lines: (f.additions ?? 0) + (f.deletions ?? 0) })), policy.fuse);
    const protectedFiles = files.map((f) => f.filename).filter((p) => matchesAny(p, policy.protectedPaths));
    return {
      fuseMs: sized.fuseMs, lines: sized.lines, rawLines: sized.rawLines, ignoredLines: sized.ignoredLines,
      protected: protectedFiles.length > 0, protectedFiles: protectedFiles.slice(0, 10),
    };
  }

  async function ensure(pr) {
    const existing = await load(pr.number);
    if (existing) return existing;
    const policy = await policyFor(pr.base.ref);
    const state = {
      v: 1, headSha: pr.head.sha, author: pr.user.login, createdAt: now(),
      expiresAt: now() + policy.ttlHours * 3600_000, ...(await sizeUp(pr, policy)),
    };
    await write(pr.number, null, state, pr);
    log(`PR #${pr.number} is on the clock: ${state.lines} lines, ${formatDuration(state.fuseMs)} fuse`);
    return load(pr.number);
  }

  async function onPullRequest(pr, action, label) {
    if (pr.draft || pr.state !== 'open') return {};
    if (action === 'labeled' && label !== 'snapgit') return {};
    if (['opened', 'reopened', 'ready_for_review', 'labeled'].includes(action)) { await ensure(pr); return {}; }
    if (action === 'synchronize') {
      const loaded = await load(pr.number);
      if (!loaded) return {};
      const policy = await policyFor(pr.base.ref);
      const s = { ...loaded.state, headSha: pr.head.sha, ...(await sizeUp(pr, policy)) };
      if (s.openedAt) {
        delete s.openedAt; delete s.openedBy; delete s.approvedBy;
        await say(pr.number, '🔄 New commits arrived, so the fuse went out. A reviewer has to look again (`/snapgit open`).');
      }
      await write(pr.number, loaded, s, pr);
    }
    return {};
  }

  /** Who may act on this PR? Returns { ok } or { ok: false, why }. The PR's author never opens or approves their own. */
  async function authorize(pr, login, { self = false } = {}) {
    const policy = await policyFor(pr.base.ref);
    const reviewers = await reviewersFor(policy, pr.base.ref);
    if (!self && login === pr.user.login) return { ok: false, why: 'you cannot review your own PR' };
    if (!isReviewer(identOf(login), reviewers)) return { ok: false, why: `only reviewers can do that (reviewers: ${reviewers.join(', ')})` };
    return { ok: true, policy, reviewers };
  }

  async function doOpen(pr, loaded, login) {
    const s = loaded.state;
    if (s.merged || s.rejected || s.expired || s.shamed) { await say(pr.number, `@${login} this PR is already settled.`); return {}; }
    const a = await authorize(pr, login);
    if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    if (s.openedAt) { await say(pr.number, `@${login} @${s.openedBy} already lit the fuse. It merges ${iso(s.openedAt + s.fuseMs)} unless rejected.`); return {}; }
    if (now() >= s.expiresAt) { await say(pr.number, `@${login} too late: this PR's lifetime is over.`); return {}; }
    const next = { ...s, openedAt: now(), openedBy: login };
    await write(pr.number, loaded, next, pr);
    return { waitFor: { number: pr.number, dueAt: dueOf(next) } };
  }

  async function doReject(pr, loaded, login, reason) {
    const s = loaded.state;
    if (s.merged || s.rejected || s.expired || s.shamed) { await say(pr.number, `@${login} this PR is already settled.`); return {}; }
    // Reviewers may reject; the author may always withdraw their own PR.
    if (login !== pr.user.login) {
      const a = await authorize(pr, login, { self: true });
      if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    }
    if (now() >= dueOf(s)) { await say(pr.number, `@${login} too late: the fuse has burned out and the merge is under way.`); return {}; }
    const next = { ...s, rejected: { by: login, at: now(), reason: reason || '' } };
    await write(pr.number, loaded, next, pr);
    await gh.closePull(pr.number);
    await gh.addLabel(pr.number, LABEL.rejected);
    return {};
  }

  async function doApprove(pr, loaded, login) {
    const s = loaded.state;
    if (!s.protected) { await say(pr.number, `@${login} this PR does not touch protected paths: it simply merges unless it is rejected.`); return {}; }
    const a = await authorize(pr, login);
    if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    await write(pr.number, loaded, { ...s, approvedBy: login }, pr);
    return {};
  }

  async function doUndo(pr, loaded, login) {
    const s = loaded.state;
    if (!s.merged) { await say(pr.number, `@${login} snapgit has not merged this PR, so there is nothing to undo.`); return {}; }
    if (s.undone) { await say(pr.number, `@${login} this was already undone (#${s.undone.number}).`); return {}; }
    const policy = await policyFor(pr.base.ref);
    const reviewers = await reviewersFor(policy, pr.base.ref);
    if (!isReviewer(identOf(login), reviewers)) { await say(pr.number, `@${login} only reviewers can undo (reviewers: ${reviewers.join(', ')}).`); return {}; }
    const revert = await gh.revertPull(pr.node_id);
    await write(pr.number, loaded, { ...s, undone: { by: login, at: now(), number: revert.number } }, pr);
    await say(pr.number, `↩️ @${login} undid this: revert PR #${revert.number} (${revert.url}). It goes through snapgit like any other PR.`);
    return {};
  }

  /** A PR comment. Returns { waitFor } if it lit a fuse. */
  async function onComment(n, comment) {
    if (comment.user?.type === 'Bot') return {};
    const firstLine = String(comment.body ?? '').trim().split('\n')[0].trim();
    const m = firstLine.match(/^\/snapgit\s+(open|reject|approve|undo)\b\s*(.*)$/i);
    if (!m) return {};
    const loaded = await load(n);
    if (!loaded) return {};
    const pr = await gh.getPull(n);
    const login = comment.user.login;
    const cmd = m[1].toLowerCase();
    if (cmd === 'open') return doOpen(pr, loaded, login);
    if (cmd === 'reject') return doReject(pr, loaded, login, m[2]);
    if (cmd === 'approve') return doApprove(pr, loaded, login);
    return doUndo(pr, loaded, login);
  }

  /** A submitted review: "changes requested" rejects, anything else from a reviewer counts as opening the PR. */
  async function onReview(n, review) {
    if (review.user?.type === 'Bot') return {};
    const loaded = await load(n);
    if (!loaded) return {};
    const pr = await gh.getPull(n);
    const login = review.user.login;
    const state = String(review.state).toLowerCase();
    if (state === 'changes_requested') return doReject(pr, loaded, login, review.body ?? '');
    if (state === 'approved' || state === 'commented') return doOpen(pr, loaded, login);
    return {};
  }

  async function removeBranch(pr) {
    if (pr.head.repo?.full_name !== gh.repo) return; // a fork's branch is not ours to delete
    await gh.deleteRef(`heads/${pr.head.ref}`);
    await gh.deleteRef(`snapgit/timer/${pr.head.ref}`);
  }

  async function authorsOf(n) {
    const people = new Map();
    const add = (name, email, login) => {
      const key = (email || name).toLowerCase();
      const prev = people.get(key);
      if (prev) { prev.login ||= login; return; }
      people.set(key, { name, email, login, agent: AGENT.test(`${name} ${email}`) || /\[bot\]$/.test(login ?? '') });
    };
    for (const c of await gh.listCommits(n)) {
      add(c.commit.author?.name ?? c.author?.login ?? 'unknown', c.commit.author?.email ?? '', c.author?.login);
      for (const t of String(c.commit.message ?? '').matchAll(/^Co-Authored-By:\s*(.+?)\s*<([^>]+)>/gim)) add(t[1], t[2], undefined);
    }
    return [...people.values()];
  }

  async function settleOne(n) {
    const pr = await gh.getPull(n);
    const loaded = await load(n);
    if (!loaded || pr.state !== 'open') return 'none';
    const s = loaded.state;
    if (s.merged || s.rejected || s.expired || s.shamed) return 'done';
    let policy;
    try { policy = await policyFor(pr.base.ref); } catch (e) { return hold(pr, loaded, e.message); }
    const due = dueOf(s);

    if (s.openedAt && !s.notes?.half && due > now() && now() >= s.openedAt + s.fuseMs / 2) {
      await say(n, `⏳ Half the fuse is gone: ${formatDuration(due - now())} left to reject this PR.`);
      loaded.state = { ...s, notes: { ...s.notes, half: true } };
      await write(n, loaded, loaded.state, pr);
      return 'pending';
    }
    if (due > now()) return 'pending';
    if (policy.frozen) return hold(pr, loaded, 'snapgit is frozen (snapgit.json says frozen: true): nothing merges or disappears until it is thawed');

    // Never opened (or a protected change nobody approved) when its lifetime ended: delete, do not merge.
    const unopened = !s.openedAt;
    const unapproved = s.protected && !s.approvedBy;
    if (unopened || (unapproved && now() >= s.expiresAt)) {
      const why = unopened ? 'Nobody ever opened this PR, so it was deleted. Nothing merged.' : 'This touches protected paths and no reviewer approved it, so it was deleted. Nothing merged.';
      const next = { ...s, expired: why };
      await write(n, loaded, next, pr);
      await say(n, `💨 ${why}`);
      await gh.closePull(n);
      await gh.addLabel(n, LABEL.expired);
      await removeBranch(pr);
      return 'done';
    }
    if (unapproved) return hold(pr, loaded, `it touches protected paths (${s.protectedFiles.slice(0, 3).join(', ')}) and needs a reviewer to say \`/snapgit approve\``);

    const ci = await gh.checkStatus(pr.head.sha, ignoreChecks);
    if (ci.state === 'pending') return hold(pr, loaded, 'CI is still running, so it cannot merge yet');
    if (ci.state === 'failure') {
      const failing = ci.failing[0];
      const authors = await authorsOf(n);
      const message = shameMessage({ id: n.toString(16).padStart(4, '0'), label: `PR #${n}`, title: pr.title, head: pr.head.ref, failure: { name: failing.name, timedOut: false }, authors });
      const mentions = authors.filter((a) => a.login && !a.agent).map((a) => `@${a.login}`).join(' ');
      await say(n, `😬 ${message}\n\n${mentions ? `${mentions}: ` : ''}"${failing.name}" failed.${failing.output ? `\n\n> ${String(failing.output).split('\n').slice(0, 8).join('\n> ')}` : ''}`);
      await write(n, loaded, { ...s, shamed: { check: failing.name, at: now() } }, pr);
      await gh.closePull(n);
      await gh.addLabel(n, LABEL.shamed);
      await removeBranch(pr);
      return 'done';
    }

    try {
      const merged = await gh.mergePull(n, { method: policy.mergeMethod, title: `${pr.title} (#${n})` });
      const next = { ...s, merged: { sha: merged.sha, at: now() } };
      await write(n, loaded, next, pr);
      await say(n, `🔀 Nobody rejected it, so it merged${ci.state === 'success' ? ' (CI passed)' : ''}. Undo with \`/snapgit undo\`.`);
      await gh.addLabel(n, LABEL.merged);
      await removeBranch(pr);
      return 'done';
    } catch (e) {
      if (e.status === 405 || e.status === 409 || e.status === 422) return hold(pr, loaded, `GitHub refused the merge (${e.message}). Branch protection or a conflict needs a human`);
      throw e;
    }
  }

  /** Say why a PR is held, once per reason. */
  async function hold(pr, loaded, reason) {
    if (loaded.state.notes?.held !== reason) {
      await say(pr.number, `✋ Held: ${reason}.`);
      const next = { ...loaded.state, notes: { ...loaded.state.notes, held: reason } };
      await write(pr.number, loaded, next, pr);
    }
    return 'held';
  }

  async function settleAll() {
    const results = {};
    for (const pr of await gh.listOpenPulls()) {
      if (!(await load(pr.number))) continue;
      results[pr.number] = await settleOne(pr.number);
    }
    return results;
  }

  /** Delete branches whose published timer (refs/snapgit/timer/<branch>) has run out. Live PRs settle their own branches. */
  async function sweepTimers() {
    const repo = await gh.getRepo();
    const safe = new Set([repo.default_branch, ...SAFE_BRANCHES]);
    const live = new Set((await gh.listOpenPulls()).map((p) => p.head.ref));
    const deleted = [];
    for (const ref of await gh.listMatchingRefs('snapgit/timer/')) {
      const timer = await gh.readBlobJson(ref.object.sha);
      if (!timer?.branch || !Number.isFinite(timer.expiresAt)) continue;
      if (timer.expiresAt > now() || safe.has(timer.branch) || live.has(timer.branch)) continue;
      const existed = await gh.deleteRef(`heads/${timer.branch}`);
      await gh.deleteRef(`snapgit/timer/${timer.branch}`);
      deleted.push({ branch: timer.branch, existed });
    }
    return deleted;
  }

  return { ensure, onPullRequest, onComment, onReview, settleOne, settleAll, sweepTimers, load, dueOf };
}
