import { parseArgs } from 'node:util';
import { hasRemote, run } from './git.js';
import { parseDuration, formatDuration, now } from './time.js';
import { createSnap, listSnaps, sweep, defaultTtlMs, getExpiry } from './snaps.js';
import { createPr, openPr, rejectPr, approvePr, burnPr, listLocalPrs, listRemotePrIds, remotePrHeads, sweepPrs, collectReceipts, receiptFor, settlePrs, previewChecks, listShame, clearShame, listMerged, undoPr, fuseOf } from './pr.js';
import { streak } from './streak.js';
import { story } from './story.js';
import { installHooks } from './hooks.js';
import { graves, resurrect } from './graveyard.js';
import { freeze, thaw, frozenReason } from './freeze.js';
import { publishTimer, sweepRemoteTimers } from './timers.js';
import { loadPolicy } from './policy.js';
import { listOutcomes, publishOutcomes } from './outcomes.js';
import { normalizeOutcome, summarize, insights, fmtDuration, pct, aggregatesCsv, recordsCsv } from '../web/lib/metrics.js';
import { resolveReviewers, ident } from './authz.js';
import { defaultBranch, currentBranch } from './git.js';
import { installAgent, installWorkflow, skillText } from './agent.js';
import { readFileSync } from 'node:fs';

const HELP = `snapgit: git, but it disappears

BRANCHES
  snapgit snap <branch> [--ttl 24h] [--from <ref>] [--stay]   new branch with a self-destruct timer
                                                              (24h by default; it can never be extended)
  snapgit ls [--json]                                         branches on the clock
  snapgit push [branch] [-r origin]                           push a branch and publish its timer, so any
                                                              runner can delete it on time
  snapgit sweep [-r origin] [--dry-run] [--quiet] [--offline] delete expired branches, settle due PRs
  snapgit watch [-r origin] [--every 5s]                      keep sweeping so fuses burn on time
  snapgit init [--agent] [--workflow]                         install hooks so sweeping is automatic; --agent adds the
                                                              coding-agent skill + AGENTS.md block, --workflow the GitHub Action
  snapgit status [--json]                                     what is on the clock, live PRs, frozen or not (for people and agents)
  snapgit skill                                               print the coding-agent skill (rules of the road for AI agents)
  snapgit graveyard                                           branches that can be resurrected
  snapgit resurrect <branch>                                  bring one back (with a fresh timer)

PULL REQUESTS  (no approve: reject, or it merges. Never opened? It is deleted)
  snapgit pr send [branch] [--base main] [-m "title\nbody"] [--ttl 24h] [-r origin] [--json]
  snapgit pr open <id> [-r origin]                            read the changes; lights a fuse sized to them
  snapgit pr reject <id> [-m reason] [-r origin]              the only button there is
  snapgit pr approve <id> [-r origin]                         only for PRs touching protectedPaths
  snapgit pr ls [-r origin] [--json]                          live PRs
  snapgit pr checks <id>                                      run the CI checks on the would-be merge
  snapgit pr receipts [-r origin]                             who opened (or screenshotted) your PRs
  snapgit pr burn <id> [-r origin]                            withdraw it (no merge)
  snapgit merged                                              what snapgit merged here
  snapgit undo <id> [--push -r origin]                        revert a merge (a revert commit, no rewriting)

SAFETY
  snapgit shame [-r origin] [--json] [--clear]                who broke CI (their branches self-destructed)
  snapgit freeze [reason] [-r origin] / thaw [-r origin]      kill switch: nothing merges or disappears
  snapgit policy                                              the effective rules (snapgit.json on base)

METRICS
  snapgit metrics [-r origin] [--since 30d] [--population human|agent] [--team t] [--json|--csv|--records]
                                                              how review is going: outcomes, time to merge, where it goes
  snapgit metrics --publish -r origin                         publish outcomes.json (branch snapgit-metrics) for the web dashboard

FOR FUN
  snapgit streak                                              your commit streak
  snapgit story [--since 24h]                                 your last day in git, then it's gone

Rules live in snapgit.json on the base branch: checks, fuse sizing and ignores, reviewers, protectedPaths.
Notifications: git config snapgit.notifyCommand / snapgit.slackWebhook.
`;

const paint = (code, s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (s = '') => { process.stdout.write(s + '\n'); };
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

export async function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === '--version' || cmd === '-v') {
      out(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      return 0;
    }
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      out(HELP);
      return 0;
    }
    if (!run(['rev-parse', '--git-dir'], { cwd }).ok) throw new Error('not inside a git repository');
    const handler = COMMANDS[cmd];
    if (!handler) throw new Error(`unknown command "${cmd}". Try snapgit help`);
    return (await handler(rest, cwd)) ?? 0;
  } catch (e) {
    process.stderr.write(`snapgit: ${e.message}\n`);
    return 1;
  }
}

const args = (argv, options, positionals = true) =>
  parseArgs({ args: argv, options, allowPositionals: positionals, strict: true });

const TTL = { ttl: { type: 'string', short: 't' } };

function printSweep({ ghosted, skipped, events, remoteGhosted = [] }, quiet, dryRun) {
  for (const e of events) {
    if (e.action === 'frozen') {
      out(`🧊 frozen (${e.reason}): nothing merges or disappears until snapgit thaw`);
    } else if (e.action === 'merged') {
      out(`🔀 PR ${e.id}: nobody rejected it, so ${e.head} merged into ${e.base}${e.checks ? ` (${e.checks} CI check${e.checks > 1 ? 's' : ''} passed)` : ''}${e.late ? ' (a rejection arrived too late)' : ''}${e.pushed ? ' and was pushed' : ''}. Undo: snapgit undo ${e.id}`);
    } else if (e.action === 'reset') {
      out(`🔄 PR ${e.id}: new commits landed on ${e.head}, so the fuse went out. A reviewer has to open it again`);
    } else if (e.action === 'withdrawn') {
      out(`🗑️ PR ${e.id}: it is gone from its remote (withdrawn or deleted), so nothing will merge`);
    } else if (e.action === 'expired') {
      out(e.reason ? `💨 PR ${e.id}: it touches protected paths and was never approved, so it was deleted. Nothing merged` : `💨 PR ${e.id}: nobody ever opened it, so it was deleted. Nothing merged`);
    } else if (e.action === 'shamed') {
      const r = e.record;
      out(`😬 PR ${e.id} failed CI: "${r.check}" ${r.timedOut ? 'timed out' : `exited ${r.exitCode}`}`);
      out(`   ${r.message}`);
      if (r.output) out(r.output.split('\n').map((l) => `   | ${l}`).join('\n'));
      for (const w of e.warnings ?? []) out(`   (${w})`);
    } else if (e.action === 'hold') {
      if (!quiet) out(`✋ PR ${e.id} is held: ${e.reason}`);
    } else if (e.action === 'rejected') {
      out(`🚫 PR ${e.id} rejected by ${e.by}${e.reason ? `: "${e.reason}"` : ''}. Nothing merged`);
    }
  }
  for (const g of ghosted) {
    out(`👻 ${dryRun ? 'would ghost' : 'ghosted'} ${g.name} (was ${g.sha}${g.remote ? ', remote too' : ''}). Bring it back: snapgit resurrect ${g.name}`);
  }
  for (const g of remoteGhosted) out(`👻 ${g.existed ? 'deleted' : 'cleared the timer of'} ${g.branch} on the remote (its published timer ran out)`);
  if (!quiet) for (const s of skipped) out(`   kept ${s.name}: ${s.reason}`);
  if (!quiet && !ghosted.length && !skipped.length && !events.length && !remoteGhosted.length) out('nothing has expired');
}

/** One full sweep: settle PRs, delete expired branches, and (with a remote) honor timers other people published. */
function fullSweep({ cwd, remote, dryRun = false, offline = false }) {
  const result = sweep({ cwd, remote, dryRun, settle: () => settlePrs({ cwd, push: !!remote, offline }) });
  if (remote && !offline && !dryRun && !result.events.some((e) => e.action === 'frozen')) {
    const live = new Set([...listLocalPrs(cwd).map((p) => p.head), ...remotePrHeads(remote, cwd)]);
    result.remoteGhosted = sweepRemoteTimers({ cwd, remote, liveHeads: live });
  }
  return result;
}

const prForBranchId = (id, cwd) => listLocalPrs(cwd).some((r) => r.id === id);

const COMMANDS = {
  snap(argv, cwd) {
    const { values, positionals } = args(argv, { ...TTL, from: { type: 'string' }, stay: { type: 'boolean' } });
    if (positionals.length !== 1) throw new Error('usage: snapgit snap <branch> [--ttl 24h]');
    const ttlMs = values.ttl ? parseDuration(values.ttl) : defaultTtlMs(cwd);
    const expiresAt = createSnap(positionals[0], { ttlMs, from: values.from, stay: values.stay, cwd });
    out(`📸 ${positionals[0]} will disappear in ${formatDuration(ttlMs)} (${when(expiresAt)}). Commit fast.`);
  },

  ls(argv, cwd) {
    const { values } = args(argv, { json: { type: 'boolean' } }, false);
    sweepQuiet(cwd);
    const snaps = listSnaps(cwd);
    if (values.json) return out(JSON.stringify(snaps.map((x) => ({ name: x.name, tip: x.tip, expiresAt: x.expiresAt, msLeft: x.expiresAt - now() })), null, 2));
    if (!snaps.length) return out('no branches on the clock. snapgit snap <name> to start one');
    for (const s of snaps) {
      const left = s.expiresAt - now();
      out(`${s.name.padEnd(30)} ${s.tip}  ${left > 0 ? paint(33, formatDuration(left) + ' left') : paint(31, 'expired, awaiting sweep')}`);
    }
  },

  sweep(argv, cwd) {
    const { values } = args(argv, {
      remote: { type: 'string', short: 'r' },
      'dry-run': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      offline: { type: 'boolean' },
    }, false);
    const dryRun = values['dry-run'];
    printSweep(fullSweep({ cwd, remote: values.remote, dryRun, offline: values.offline }), values.quiet, dryRun);
    if (!dryRun) {
      for (const id of sweepPrs(cwd)) out(`💨 PR ${id} dropped: its branch is gone, nothing to merge`);
    }
  },

  shame(argv, cwd) {
    const { values } = args(argv, { remote: { type: 'string', short: 'r' }, json: { type: 'boolean' }, clear: { type: 'boolean' } }, false);
    const remote = values.remote ?? (hasRemote('origin', cwd) ? 'origin' : undefined);
    const records = listShame({ cwd, remote });
    if (values.json) out(JSON.stringify(records, null, 2));
    else if (!records.length) out('nobody has been shamed. Yet');
    else for (const r of records) { out(`😬 ${r.message}`); if (r.output) out(r.output.split('\n').map((l) => `   | ${l}`).join('\n')); }
    if (values.clear) out(`cleared ${clearShame({ cwd, remote })} record(s)`);
  },

  metrics(argv, cwd) {
    const { values } = args(argv, {
      remote: { type: 'string', short: 'r' }, since: { type: 'string' }, population: { type: 'string' }, team: { type: 'string' },
      json: { type: 'boolean' }, csv: { type: 'boolean' }, records: { type: 'boolean' }, publish: { type: 'boolean' },
    }, false);
    const remote = values.remote ?? (hasRemote('origin', cwd) ? 'origin' : undefined);
    const raw = listOutcomes({ cwd, remote });
    if (values.publish) {
      if (!remote) throw new Error('--publish needs a remote (-r origin)');
      out(`📊 published ${publishOutcomes({ cwd, remote, outcomes: raw })} outcomes to ${remote}/snapgit-metrics (outcomes.json). Point the dashboard at this repository.`);
      return;
    }
    const population = values.population ?? 'all';
    if (!['all', 'human', 'agent'].includes(population)) throw new Error('--population is all, human or agent');
    const windowMs = parseDuration(values.since ?? '30d');
    const records = raw.map(normalizeOutcome).filter(Boolean);
    const summary = summarize(records, { since: now() - windowMs, until: now(), population, team: values.team ?? null });
    if (values.json) out(JSON.stringify(summary, null, 2));
    else if (values.csv) process.stdout.write(aggregatesCsv(summary));
    else if (values.records) process.stdout.write(recordsCsv(records.filter((r) => r.settledAt >= now() - windowMs)));
    else printMetrics(summary, formatDuration(windowMs));
  },

  merged(argv, cwd) {
    const list = listMerged(cwd);
    if (!list.length) return out('snapgit has not merged anything here');
    for (const m of list) out(`${m.id}  ${m.title}  (${m.head} -> ${m.base}, ${when(m.mergedAt)})${m.undoneAt ? '  ↩️ undone' : ''}`);
  },

  undo(argv, cwd) {
    const { values, positionals } = args(argv, { remote: { type: 'string', short: 'r' }, push: { type: 'boolean' } });
    if (positionals.length !== 1) throw new Error('usage: snapgit undo <id> [--push -r origin]');
    const r = undoPr(positionals[0], { cwd, remote: values.remote, push: values.push });
    out(`↩️ undone: ${r.base} now has revert commit ${r.revert}${r.pushed ? ' (pushed)' : ''}. The branch can come back with: snapgit resurrect ${r.head}`);
  },

  graveyard(argv, cwd) {
    const list = graves(cwd);
    if (!list.length) return out('the graveyard is empty');
    for (const g of list) out(`${g.name.padEnd(30)} ${g.sha.slice(0, 7)}  ghosted ${when(g.buriedAt)}`);
  },

  resurrect(argv, cwd) {
    const { positionals } = args(argv, {});
    if (positionals.length !== 1) throw new Error('usage: snapgit resurrect <branch>');
    const r = resurrect(positionals[0], cwd);
    out(`🧟 ${positionals[0]} is back at ${r.sha}, with a fresh timer: it disappears again ${when(r.expiresAt)}`);
  },

  freeze(argv, cwd) {
    const { values, positionals } = args(argv, { remote: { type: 'string', short: 'r' } });
    freeze({ cwd, remote: values.remote, reason: positionals.join(' ') || 'frozen' });
    out(`🧊 frozen${values.remote ? ` (and published to ${values.remote})` : ''}. Nothing merges or disappears until: snapgit thaw`);
  },

  thaw(argv, cwd) {
    const { values } = args(argv, { remote: { type: 'string', short: 'r' } }, false);
    thaw({ cwd, remote: values.remote });
    out('☀️ thawed. Anything that came due while frozen settles at the next sweep');
  },

  push(argv, cwd) {
    const { values, positionals } = args(argv, { remote: { type: 'string', short: 'r' } });
    const remote = values.remote ?? 'origin';
    if (!hasRemote(remote, cwd)) throw new Error(`no remote named ${remote}`);
    const branch = positionals[0] ?? currentBranch(cwd);
    const expiresAt = getExpiry(branch, cwd);
    if (expiresAt === null) throw new Error(`${branch} has no timer: make branches with snapgit snap`);
    const pushed = run(['push', '-u', remote, branch], { cwd });
    if (!pushed.ok) throw new Error(`push failed: ${pushed.err}`);
    out(`⬆️ pushed ${branch} to ${remote}. ${publishTimer(branch, expiresAt, remote, cwd) ? `Its timer is published: any runner can delete it at ${when(expiresAt)}` : 'The remote already has a timer for it, and timers cannot change'}`);
  },

  policy(argv, cwd) {
    const base = defaultBranch(cwd);
    const p = loadPolicy(base, cwd);
    out(`policy from ${base}:snapgit.json${run(['cat-file', '-e', `refs/heads/${base}:snapgit.json`], { cwd }).ok ? '' : ' (none, defaults)'}`);
    out(JSON.stringify({ ...p, reviewers: p.reviewers === 'CODEOWNERS' ? resolveReviewers(p, base, cwd) : p.reviewers }, null, 2));
    out(`you are: ${ident(cwd)}`);
    const fr = frozenReason({ cwd });
    if (fr) out(`🧊 frozen: ${fr}`);
  },

  async watch(argv, cwd) {
    const { values } = args(argv, { remote: { type: 'string', short: 'r' }, every: { type: 'string' } }, false);
    const everyMs = parseDuration(values.every ?? '5s');
    out(`👀 watching every ${formatDuration(everyMs)}${values.remote ? ` (remote ${values.remote})` : ''}. Ctrl-C to stop`);
    for (;;) {
      printSweep(fullSweep({ cwd, remote: values.remote }), true, false);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  },

  init(argv, cwd) {
    const { values } = args(argv, { agent: { type: 'boolean' }, workflow: { type: 'boolean' } }, false);
    const installed = installHooks(cwd);
    out(installed.length ? `hooks installed: ${installed.join(', ')}. Expired branches now vanish on their own.` : 'hooks already installed');
    if (values.agent) out(`🤖 agent skill: wrote ${installAgent(cwd).join(', ') || 'nothing new'}`);
    if (values.workflow) {
      const w = installWorkflow(cwd);
      out(w ? `🤖 wrote ${w}. Commit it to your default branch to put real PRs on the clock` : 'the workflow already exists, left alone');
    }
  },

  skill() {
    process.stdout.write(skillText());
  },

  status(argv, cwd) {
    const { values } = args(argv, { json: { type: 'boolean' }, remote: { type: 'string', short: 'r' } }, false);
    sweepQuiet(cwd);
    const snaps = listSnaps(cwd).map((x) => ({ name: x.name, expiresAt: x.expiresAt, msLeft: x.expiresAt - now() }));
    const prs = listLocalPrs(cwd).map((r) => {
      const rc = receiptFor(r.id, cwd);
      const dueAt = Math.min(r.expiresAt, rc ? rc.openedAt + fuseOf(r) : Infinity);
      return { id: r.id, title: r.title, head: r.head, base: r.base, lines: r.lines, opened: !!rc, openedBy: rc?.opener ?? null, validated: !!r.validated, protected: !!r.protected, mergesAt: rc ? dueAt : null, expiresAt: r.expiresAt };
    });
    const remote = values.remote ?? (hasRemote('origin', cwd) ? 'origin' : undefined);
    const st = {
      branch: currentBranch(cwd),
      onTheClock: snaps,
      prs,
      frozen: frozenReason({ cwd }) ?? null,
      shamed: listShame({ cwd, remote }).length,
      merged: listMerged(cwd).length,
    };
    if (values.json) return out(JSON.stringify(st, null, 2));
    const here = snaps.find((x) => x.name === st.branch);
    out(`on ${st.branch}${here ? `: disappears in ${formatDuration(here.msLeft)}` : ' (no timer)'}`);
    out(`${snaps.length} branch${snaps.length === 1 ? '' : 'es'} on the clock, ${prs.length} live PR${prs.length === 1 ? '' : 's'}, ${st.merged} merged, ${st.shamed} shamed`);
    for (const p of prs) out(`   ${p.id}  ${p.title}  ${p.opened ? `opened by ${p.openedBy}, merges in ${formatDuration(Math.max(0, p.mergesAt - now()))}` : `unopened, deleted in ${formatDuration(Math.max(0, p.expiresAt - now()))}`}`);
    if (st.frozen) out(`🧊 frozen: ${st.frozen}`);
  },

  story(argv, cwd) {
    const { values } = args(argv, { since: { type: 'string' } }, false);
    const windowMs = parseDuration(values.since ?? '24h');
    const s = story(cwd, windowMs);
    out(`📖 your story, last ${formatDuration(windowMs)}`);
    if (!s.commits.length && !s.snaps.length && !s.prs.length) return out('   nothing. Quiet day. It would have disappeared anyway.');
    for (const c of s.commits) out(`   ${c.sha}  ${c.subject}  ${paint(2, `(${c.refs})`)}`);
    for (const b of s.snaps) out(`   ⏳ ${b.name} vanishes in ${formatDuration(b.expiresAt - now())}`);
    for (const p of s.prs) {
      const rc = receiptFor(p.id, cwd);
      const due = Math.min(p.expiresAt, rc ? rc.openedAt + fuseOf(p) : Infinity);
      out(`   📨 PR ${p.id} "${p.title}" merges into ${p.base} in ${formatDuration(due - now())} unless rejected`);
    }
    out(`   🔥 ${s.streak.current} day streak`);
    out('   (this story will not be saved)');
  },

  streak(argv, cwd) {
    const s = streak(cwd);
    if (!s.current) return out(`💀 no streak. Longest ever: ${s.longest}. Commit something.`);
    out(`🔥 ${s.current} day streak${s.doneToday ? '' : ' (commit today or lose it)'}. Longest: ${s.longest}.`);
  },

  async pr(argv, cwd) {
    const [sub, ...rest] = argv;
    const remoteOpt = { remote: { type: 'string', short: 'r' } };
    if (sub === 'send') {
      const { values, positionals } = args(rest, { ...remoteOpt, ...TTL, base: { type: 'string', short: 'b' }, message: { type: 'string', short: 'm' }, json: { type: 'boolean' } });
      const remote = values.remote;
      if (remote && !hasRemote(remote, cwd)) throw new Error(`no remote named ${remote}`);
      const sent = createPr({ cwd, head: positionals[0], base: values.base, message: values.message?.replace(/\\n/g, '\n'), ttlMs: values.ttl ? parseDuration(values.ttl) : undefined, remote });
      if (values.json) {
        if (sent.shame) {
          const r = sent.shame;
          sweep({ cwd, settle: () => settlePrs({ cwd, offline: true }) });
          const branchDeleted = !run(['rev-parse', '--verify', '-q', `refs/heads/${r.head}`], { cwd }).ok;
          out(JSON.stringify({ ok: false, shamed: { head: r.head, check: r.check, exitCode: r.exitCode ?? null, timedOut: !!r.timedOut, message: r.message, output: r.output ?? '', branchDeleted, ...(branchDeleted ? {} : { note: `${r.head} is checked out, so it vanishes once you switch to another branch (git switch ${defaultBranch(cwd)}). Fix the cause on a new branch.` }) } }, null, 2));
          return 1;
        }
        const p = sent.pr;
        out(JSON.stringify({ ok: true, id: p.id, title: p.title, head: p.head, base: p.base, lines: p.lines, fuseMs: p.fuseMs, expiresAt: p.expiresAt, protected: !!p.protected, checksPassed: sent.ran ?? 0, warnings: sent.warnings ?? [] }, null, 2));
        return;
      }
      if (sent.shame) {
        const r = sent.shame;
        out(`😬 not sent: ${r.head} failed CI before anyone had to look at it ("${r.check}" ${r.timedOut ? 'timed out' : `exited ${r.exitCode}`})`);
        out(`   ${r.message}`);
        if (r.output) out(r.output.split('\n').map((l) => `   | ${l}`).join('\n'));
        for (const w of sent.warnings ?? []) out(`   (${w})`);
        printSweep(sweep({ cwd, settle: () => settlePrs({ cwd, offline: true }) }), false, false);
        return 1;
      }
      const rec = sent.pr;
      out(`📨 sent "${rec.title}" (${rec.head} -> ${rec.base})${sent.ran ? `, ${sent.ran} CI check${sent.ran > 1 ? 's' : ''} passed` : ''}`);
      const ignored = rec.ignoredLines ? ` (${rec.ignoredLines} more in ignored files)` : '';
      out(`   id ${rec.id}, ${rec.lines} changed line${rec.lines === 1 ? '' : 's'}${ignored} = a ${formatDuration(rec.fuseMs)} fuse: it merges into ${rec.base} that long after it is first opened unless rejected. Never opened by ${when(rec.expiresAt)}? It is deleted`);
      if (rec.protected) out(`   touches protected paths (${rec.protectedFiles.slice(0, 3).join(', ')}): a reviewer must also run snapgit pr approve ${rec.id}`);
      for (const w of sent.warnings ?? []) out(`   (${w})`);
      out(remote ? `   recipient: snapgit pr open ${rec.id} -r ${remote}   (or snapgit pr reject ${rec.id} -r ${remote})` : `   not pushed anywhere yet; use --remote <name> to deliver it`);
      return;
    }
    if (sub === 'open') {
      const { values, positionals } = args(rest, { ...remoteOpt, screenshot: { type: 'boolean' } });
      if (positionals.length !== 1) throw new Error('usage: snapgit pr open <id>');
      const screenshot = !process.stdout.isTTY;
      if (screenshot && !values.screenshot) {
        throw new Error('stdout is not a terminal, which looks suspiciously like a screenshot. Nothing was burned. Pass --screenshot if you insist');
      }
      const remote = values.remote ?? (hasRemote('origin', cwd) && !prForBranchId(positionals[0], cwd) ? 'origin' : undefined); // a local-only PR must not be judged by origin
      const { record, receipt, mergesAt } = openPr(positionals[0], { cwd, remote, screenshot });
      render(record, receipt, mergesAt, screenshot);
      return;
    }
    if (sub === 'reject') {
      const { values, positionals } = args(rest, { ...remoteOpt, message: { type: 'string', short: 'm' } });
      if (positionals.length !== 1) throw new Error('usage: snapgit pr reject <id> [-m reason]');
      const remote = values.remote ?? (hasRemote('origin', cwd) && !prForBranchId(positionals[0], cwd) ? 'origin' : undefined);
      rejectPr(positionals[0], { cwd, remote, reason: values.message });
      out('🚫 rejected. It will not be merged');
      return;
    }
    if (sub === 'approve') {
      const { values, positionals } = args(rest, remoteOpt);
      if (positionals.length !== 1) throw new Error('usage: snapgit pr approve <id>');
      const remote = values.remote ?? (hasRemote('origin', cwd) && !prForBranchId(positionals[0], cwd) ? 'origin' : undefined);
      const a = approvePr(positionals[0], { cwd, remote });
      out(`✅ approved by ${a.approver}. It still merges only if its fuse burns out unrejected`);
      return;
    }
    if (sub === 'ls') {
      const { values } = args(rest, { ...remoteOpt, json: { type: 'boolean' } }, false);
      const local = listLocalPrs(cwd);
      if (values.json) {
        const remoteOnly = values.remote ? listRemotePrIds(values.remote, cwd).filter((id) => !local.some((r) => r.id === id)) : [];
        return out(JSON.stringify({
          prs: local.map((r) => {
            const rc = receiptFor(r.id, cwd);
            return { id: r.id, title: r.title, head: r.head, base: r.base, lines: r.lines, opened: !!rc, openedBy: rc?.opener ?? null, mergesAt: rc ? Math.min(r.expiresAt, rc.openedAt + fuseOf(r)) : null, expiresAt: r.expiresAt };
          }),
          remoteOnly,
        }, null, 2));
      }
      for (const r of local) {
        const rc = receiptFor(r.id, cwd);
        const due = Math.min(r.expiresAt, rc ? rc.openedAt + fuseOf(r) : Infinity);
        const left = due - now();
        out(`${r.id}  ${r.title}  (${r.head} -> ${r.base}, ${rc ? `opened by ${rc.opener}` : 'unopened'}, ${left > 0 ? `merges in ${formatDuration(left)}` : 'merging at next sweep'} unless rejected)`);
      }
      if (values.remote) {
        const seen = new Set(local.map((r) => r.id));
        for (const id of listRemotePrIds(values.remote, cwd)) if (!seen.has(id)) out(`${id}  live on ${values.remote}`);
      }
      if (!local.length && !values.remote) out('no pending PRs');
      return;
    }
    if (sub === 'receipts') {
      const { values } = args(rest, remoteOpt, false);
      const receipts = collectReceipts({ cwd, remote: values.remote ?? (hasRemote('origin', cwd) ? 'origin' : undefined) });
      if (!receipts.length) return out('no new read receipts');
      for (const r of receipts) {
        out(`👀 ${r.opener} opened "${r.title}" (#${r.id}) at ${when(r.openedAt)}${r.screenshot ? ' 📸 and took a screenshot' : ''}`);
      }
      return;
    }
    if (sub === 'checks') {
      const { positionals } = args(rest, {});
      if (positionals.length !== 1) throw new Error('usage: snapgit pr checks <id>');
      const r = previewChecks(positionals[0], { cwd });
      if (!r.checks) return out('no checks defined (add snapgit.json to the base branch)');
      for (const c of r.results) out(`${c.code === 0 ? '✅' : '❌'} ${c.name}${c.code === 0 ? '' : c.timedOut ? ' (timed out)' : ` (exit ${c.code})`}`);
      if (!r.ok) out(r.results.at(-1).output.split('\n').map((l) => `   | ${l}`).join('\n'));
      return r.ok ? 0 : 1;
    }
    if (sub === 'burn') {
      const { values, positionals } = args(rest, remoteOpt);
      if (positionals.length !== 1) throw new Error('usage: snapgit pr burn <id>');
      if (!burnPr(positionals[0], { cwd, remote: values.remote })) throw new Error(`PR ${positionals[0]} not found`);
      out('🔥 burned');
      return;
    }
    throw new Error('usage: snapgit pr <send|open|reject|approve|ls|checks|receipts|burn>');
  },
};

function printMetrics(s, windowLabel) {
  const st = s.stats;
  out(`📊 snapgit metrics, last ${windowLabel}${s.population !== 'all' ? `, ${s.population}-authored only` : ''}${s.team ? `, team ${s.team}` : ''}: ${s.total} settled PR${s.total === 1 ? '' : 's'}`);
  if (!s.total) return out('   nothing settled in this window yet. (Outcomes are recorded whenever snapgit settles a PR.)');
  out(`   merged ${pct(st.mergeRate)}   rejected ${st.rejected}   expired unopened ${pct(st.expiredRate)}   failed CI ${pct(st.shameRate)}   undone ${pct(st.undoRate)} of merges`);
  out(`   time to merge: median ${fmtDuration(st.p50)}   p75 ${fmtDuration(st.p75)}   p90 ${fmtDuration(st.p90)}`);
  const b = s.breakdown;
  if (b.n) out(`   where it goes (median of ${b.n} merged): CI ${fmtDuration(b.ci)}, waiting for a reviewer ${fmtDuration(b.reviewer)}, fuse ${fmtDuration(b.fuse)}`);
  const line = (name, g) => out(g.suppressed ? `   ${name}: fewer than ${s.minGroup} PRs, not shown` : `   ${name}: ${g.n} PRs, merged ${pct(g.mergeRate)}, failed CI ${pct(g.shameRate)}, median ${fmtDuration(g.p50)}`);
  if (s.population === 'all') { out('   by author kind'); line('  human', s.populations.human); line('  agent', s.populations.agent); }
  if (s.teams.length) { out('   by team'); for (const t of s.teams) line(`  ${t.team}`, t); }
  out('');
  for (const i of insights(s)) out(`   ${i.tone === 'good' ? '✅' : i.tone === 'caution' ? '⚠️' : '•'} ${i.text}`);
  out('');
  out('   (No baseline here: the CLI only sees snapgit PRs. The web dashboard compares against ordinary GitHub PRs.)');
}

function sweepQuiet(cwd) {
  printSweep(sweep({ cwd, settle: () => settlePrs({ cwd, offline: true }) }), true, false);
  sweepPrs(cwd);
}

function render(r, receipt, mergesAt, screenshot) {
  const bar = '━'.repeat(60);
  out(paint(35, bar));
  out(`${paint(1, r.title)}   ${paint(2, `#${r.id}`)}`);
  out(`${r.author}  ·  ${r.head} -> ${r.base}  ·  sent ${when(r.createdAt)}`);
  if (r.validated) out(`✅ validated before review: ${r.validated.checks ? `${r.validated.checks} CI check${r.validated.checks > 1 ? 's' : ''} passed` : 'no CI checks defined'}`);
  if (r.message) out(`\n${r.message}`);
  if (r.commits.length) out(`\n${r.commits.map((c) => '  ' + c).join('\n')}`);
  out(`\n${r.stat}\n`);
  for (const line of r.patch.trimEnd().split('\n')) {
    out(line.startsWith('+') && !line.startsWith('+++') ? paint(32, line) : line.startsWith('-') && !line.startsWith('---') ? paint(31, line) : line);
  }
  out(paint(35, bar));
  out(`⏳ the fuse is lit: ${r.head} merges into ${r.base} in ${formatDuration(mergesAt - now())} unless you run: snapgit pr reject ${r.id}`);
  out(`   (re-read the changes any time before then with: snapgit pr open ${r.id})`);
  if (screenshot) out('📸 screenshot detected. The sender will see that in their read receipt.');
}
