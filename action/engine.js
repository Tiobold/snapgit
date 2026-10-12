// snapgit rules for real GitHub PRs. Same semantics as the CLI:
//   - no approve: a reviewer lights the fuse (/snapgit open, or any submitted review) and the PR merges when it
//     burns out, unless it is rejected (/snapgit reject, or a "changes requested" review);
//   - a PR nobody ever opens is closed and its branch deleted when its lifetime (ttlHours) is up;
//   - review is locked until validation (GitHub's own checks) has passed: no fuse before CI is green. If CI fails,
//     the authors are shamed and the branch self-destructs straight away, before anyone has to look;
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

export function createEngine({ gh, now = () => Date.now(), ignoreChecks = ['snapgit'], ciGraceMs = 30_000, log = () => {} }) {
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
    const prot = s.protected && !s.approvedBy ? ` ✋ It touches protected paths (${s.protectedFiles.slice(0, 3).join(', ')}), so a reviewer must also \`/snapgit approve\`.` : '';
    let line;
    if (s.merged) line = `🔀 Merged${s.merged.sha ? ` as \`${s.merged.sha.slice(0, 7)}\`` : ''}. Undo with \`/snapgit undo\`.`;
    else if (s.rejected) line = `🚫 Rejected by @${s.rejected.by}${s.rejected.reason ? `: ${s.rejected.reason}` : ''}. Nothing merged.`;
    else if (s.expired) line = `💨 ${s.expired}`;
    else if (s.shamed) line = '😬 Failed CI. The branch self-destructed.';
    else if (s.openedAt) line = `🔥 Fuse lit by @${s.openedBy}. It merges ${iso(s.openedAt + s.fuseMs)} unless rejected (\`/snapgit reject\` or request changes).${prot}`;
    else if (!s.ciPassedAt) line = `🧪 Waiting for CI. Reviewing is locked until validation passes (no fuse before then); I'll say here when it is ready. Never opened by ${iso(s.expiresAt)}? It is deleted.${prot}`;
    else line = `✅ CI passed. ⏳ Waiting for a reviewer. Say \`/snapgit open\` (or submit a review) to light the ${formatDuration(s.fuseMs)} fuse. Nobody opens it by ${iso(s.expiresAt)}? It is deleted.${prot}`;
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
      const s = { ...loaded.state, headSha: pr.head.sha, headSeenAt: now(), ...(await sizeUp(pr, policy)) };
      delete s.ciPassedAt; // new commits need validating again
      delete s.approvedBy; // and an approval was for the old code
      if (s.openedAt) {
        delete s.openedAt; delete s.openedBy;
        await say(pr.number, '🔄 New commits arrived, so the fuse went out and CI has to pass again before a reviewer can look (`/snapgit open`).');
      }
      await write(pr.number, loaded, s, pr);
    }
    return {};
  }

  const MEMBERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

  /**
   * Who may act on this PR? Returns { ok } or { ok: false, why }. The PR's author never opens or approves their own.
   * With no reviewers configured, only repository members (owner, member, collaborator) count, so a throwaway second
   * account cannot play reviewer.
   */
  async function authorize(pr, login, { self = false, assoc } = {}) {
    const policy = await policyFor(pr.base.ref);
    const reviewers = await reviewersFor(policy, pr.base.ref);
    if (!self && login === pr.user.login) return { ok: false, why: 'you cannot review your own PR' };
    if (reviewers) {
      if (!isReviewer(identOf(login), reviewers)) return { ok: false, why: `only reviewers can do that (reviewers: ${reviewers.join(', ')})` };
    } else if (!MEMBERS.has(assoc)) {
      return { ok: false, why: 'only repository members can do that (or list reviewers in snapgit.json)' };
    }
    return { ok: true, policy, reviewers };
  }

  /**
   * Has this PR been validated? 'success' (CI green, or genuinely none), 'pending' (running, or not started yet:
   * right after a push there is a short grace window before "no checks" is believed) or 'failure'.
   */
  async function validation(pr, s, policy) {
    const ci = await gh.checkStatus(pr.head.sha, ignoreChecks);
    if (ci.state === 'none' && policy?.requireChecks) return { state: 'pending', ci, why: 'this repo requires CI checks and none have run (a first-time contributor\'s workflows may be waiting for approval)' };
    if (ci.state === 'none') {
      const since = s.headSeenAt ?? s.createdAt;
      return now() - since < ciGraceMs ? { state: 'pending', ci, why: 'CI has not started yet' } : { state: 'success', ci };
    }
    return { state: ci.state, ci, why: ci.state === 'pending' ? 'CI is still running' : undefined };
  }

  /** CI failed: shame the authors, close the PR, delete the branch. */
  async function shame(pr, loaded, failing) {
    const n = pr.number;
    const authors = await authorsOf(n);
    const message = shameMessage({ id: n.toString(16).padStart(4, '0'), label: `PR #${n}`, title: pr.title, head: pr.head.ref, failure: { name: failing.name, timedOut: false }, authors });
    const mentions = authors.filter((a) => a.login && !a.agent).map((a) => `@${a.login}`).join(' ');
    await say(n, `😬 ${message}\n\n${mentions ? `${mentions}: ` : ''}"${failing.name}" failed.${failing.output ? `\n\n> ${String(failing.output).split('\n').slice(0, 8).join('\n> ')}` : ''}`);
    await write(n, loaded, { ...loaded.state, shamed: { check: failing.name, at: now() } }, pr);
    await gh.closePull(n);
    await gh.addLabel(n, LABEL.shamed);
    await removeBranch(pr);
  }

  async function doOpen(pr, loaded, login, assoc) {
    const s = loaded.state;
    if (s.merged || s.rejected || s.expired || s.shamed) { await say(pr.number, `@${login} this PR is already settled.`); return {}; }
    const a = await authorize(pr, login, { assoc });
    if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    if (s.openedAt) { await say(pr.number, `@${login} @${s.openedBy} already lit the fuse. It merges ${iso(s.openedAt + s.fuseMs)} unless rejected.`); return {}; }
    if (now() >= s.expiresAt) { await say(pr.number, `@${login} too late: this PR's lifetime is over.`); return {}; }
    if (s.expiresAt - now() < s.fuseMs) {
      await say(pr.number, `@${login} too late to review: ${formatDuration(Math.max(0, s.expiresAt - now()))} of lifetime left, but the fuse needs ${formatDuration(s.fuseMs)}. A fuse cut short by the deadline would be a rubber stamp, so this PR will be deleted.`);
      return {};
    }
    const policy = await policyFor(pr.base.ref);
    const v = await validation(pr, s, policy);
    if (v.state !== 'success') {
      await say(pr.number, `@${login} not yet: ${v.state === 'failure' ? `CI is failing ("${v.ci.failing[0].name}")` : v.why}. Reviewing is locked until validation passes, so there is no fuse yet. I will comment here when it is ready.`);
      return {};
    }
    const next = { ...s, ciPassedAt: s.ciPassedAt ?? now(), openedAt: now(), openedBy: login };
    await write(pr.number, loaded, next, pr);
    return { waitFor: { number: pr.number, dueAt: dueOf(next) } };
  }

  async function doReject(pr, loaded, login, reason, assoc) {
    const s = loaded.state;
    if (s.merged || s.rejected || s.expired || s.shamed) { await say(pr.number, `@${login} this PR is already settled.`); return {}; }
    // Reviewers may reject; the author may always withdraw their own PR.
    if (login !== pr.user.login) {
      const a = await authorize(pr, login, { self: true, assoc });
      if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    }
    if (now() >= dueOf(s)) { await say(pr.number, `@${login} too late: the fuse has burned out and the merge is under way.`); return {}; }
    const next = { ...s, rejected: { by: login, at: now(), reason: reason || '' } };
    await write(pr.number, loaded, next, pr);
    await gh.closePull(pr.number);
    await gh.addLabel(pr.number, LABEL.rejected);
    return {};
  }

  async function doApprove(pr, loaded, login, assoc) {
    const s = loaded.state;
    if (!s.protected) { await say(pr.number, `@${login} this PR does not touch protected paths: it simply merges unless it is rejected.`); return {}; }
    const a = await authorize(pr, login, { assoc });
    if (!a.ok) { await say(pr.number, `@${login} ${a.why}.`); return {}; }
    await write(pr.number, loaded, { ...s, approvedBy: login }, pr);
    return {};
  }

  async function doUndo(pr, loaded, login, assoc) {
    const s = loaded.state;
    if (!s.merged) { await say(pr.number, `@${login} snapgit has not merged this PR, so there is nothing to undo.`); return {}; }
    if (s.undone) { await say(pr.number, `@${login} this was already undone (#${s.undone.number}).`); return {}; }
    const policy = await policyFor(pr.base.ref);
    const reviewers = await reviewersFor(policy, pr.base.ref);
    if (reviewers ? !isReviewer(identOf(login), reviewers) : !MEMBERS.has(assoc)) { await say(pr.number, `@${login} only reviewers can undo${reviewers ? ` (reviewers: ${reviewers.join(', ')})` : ' (repository members, or list reviewers in snapgit.json)'}.`); return {}; }
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
    const assoc = comment.author_association;
    const cmd = m[1].toLowerCase();
    if (cmd === 'open') return doOpen(pr, loaded, login, assoc);
    if (cmd === 'reject') return doReject(pr, loaded, login, m[2], assoc);
    if (cmd === 'approve') return doApprove(pr, loaded, login, assoc);
    return doUndo(pr, loaded, login, assoc);
  }

  /** A submitted review: "changes requested" rejects, anything else from a reviewer counts as opening the PR. */
  async function onReview(n, review) {
    if (review.user?.type === 'Bot') return {};
    const loaded = await load(n);
    if (!loaded) return {};
    const pr = await gh.getPull(n);
    const login = review.user.login;
    const state = String(review.state).toLowerCase();
    if (state === 'changes_requested') return doReject(pr, loaded, login, review.body ?? '', review.author_association);
    if (state === 'approved' || state === 'commented') return doOpen(pr, loaded, login, review.author_association);
    return {};
  }

  let defaultBranch = null;
  const protectedBranch = async (name, pr) => {
    defaultBranch ??= (await gh.getRepo()).default_branch;
    return name === defaultBranch || name === pr.base.ref || SAFE_BRANCHES.includes(name);
  };

  /** Keep a copy of the tip before deleting a branch: refs/snapgit/graveyard/<ms>-<branch> (resurrect with git). */
  async function bury(name) {
    const sha = await gh.branchSha(name);
    if (sha) await gh.createRef(`snapgit/graveyard/${now()}-${name}`, sha).catch(() => {});
  }

  async function removeBranch(pr) {
    if (pr.head.repo?.full_name !== gh.repo) return; // a fork's branch is not ours to delete
    if (await protectedBranch(pr.head.ref, pr)) return; // never the default or base branch, whatever the PR says
    await bury(pr.head.ref);
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
    if (!s.openedAt && !policy.frozen) {
      // Validation gate: nothing is reviewable until CI has run. Failing CI is shamed straight away.
      const v = await validation(pr, s, policy);
      if (v.state === 'failure') { await shame(pr, loaded, v.ci.failing[0]); return 'done'; }
      if (v.state === 'success' && !s.ciPassedAt) {
        loaded.state = { ...s, ciPassedAt: now() };
        await write(n, loaded, loaded.state, pr);
        await say(n, `✅ CI passed. This PR is ready for review: a reviewer can say \`/snapgit open\` (or submit a review) to light the ${formatDuration(s.fuseMs)} fuse.`);
        return due > now() ? 'pending' : settleOne(n);
      }
    }
    if (s.headSha && pr.head.sha !== s.headSha) {
      // The branch moved and we missed (or raced) the event. What was reviewed is not what would merge.
      const next = { ...s, headSha: pr.head.sha, headSeenAt: now() };
      delete next.openedAt; delete next.openedBy; delete next.ciPassedAt; delete next.approvedBy;
      await say(n, '🔄 The branch moved after review, so the fuse went out and CI has to pass again before a reviewer can look (`/snapgit open`).');
      await write(n, loaded, { ...next, ...(await sizeUp(pr, policy)) }, pr);
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
      await shame(pr, loaded, ci.failing[0]);
      return 'done';
    }

    try {
      const merged = await gh.mergePull(n, { method: policy.mergeMethod, title: `${pr.title} (#${n})`, sha: s.headSha });
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

  /** A check finished somewhere: re-evaluate the open PRs on that commit (so validation is noticed at once). */
  async function onChecks(sha) {
    const results = {};
    for (const pr of await gh.listOpenPulls()) {
      if (pr.head.sha !== sha || !(await load(pr.number))) continue;
      results[pr.number] = await settleOne(pr.number);
    }
    return results;
  }

  /** Delete branches whose published timer (refs/snapgit/timer/<branch>) has run out. Live PRs settle their own branches. */
  async function sweepTimers() {
    const repo = await gh.getRepo();
    try { if ((await policyFor(repo.default_branch)).frozen) return []; } catch { return []; } // frozen, or the policy is unreadable: delete nothing
    const safe = new Set([repo.default_branch, ...SAFE_BRANCHES]);
    const live = new Set((await gh.listOpenPulls()).map((p) => p.head.ref));
    const deleted = [];
    for (const ref of await gh.listMatchingRefs('snapgit/timer/')) {
      const timer = await gh.readBlobJson(ref.object.sha);
      if (!timer?.branch || !Number.isFinite(timer.expiresAt)) continue;
      if (timer.expiresAt > now() || safe.has(timer.branch) || live.has(timer.branch)) continue;
      await bury(timer.branch); // keep the tip: the deleted branch can be recovered from refs/snapgit/graveyard/*
      const existed = await gh.deleteRef(`heads/${timer.branch}`);
      await gh.deleteRef(`snapgit/timer/${timer.branch}`);
      deleted.push({ branch: timer.branch, existed });
    }
    return deleted;
  }

  return { ensure, onPullRequest, onComment, onReview, onChecks, settleOne, settleAll, sweepTimers, load, dueOf };
}
