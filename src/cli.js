import { parseArgs } from 'node:util';
import { hasRemote, run } from './git.js';
import { parseDuration, formatDuration, now } from './time.js';
import { createSnap, listSnaps, setExpiry, getExpiry, clearExpiry, sweep } from './snaps.js';
import { createPr, openPr, rejectPr, burnPr, listLocalPrs, listRemotePrIds, sweepPrs, collectReceipts, receiptFor, settlePrs, retimePr, prForBranch, fuseMs } from './pr.js';
import { streak } from './streak.js';
import { story } from './story.js';
import { installHooks } from './hooks.js';

const HELP = `snapgit: git, but it disappears

  snapgit snap <branch> [--ttl 24h] [--from <ref>] [--stay]   new branch with a self-destruct timer
  snapgit ls                                                  branches on the clock
  snapgit extend <branch> <duration>                          buy more time (e.g. 12h)
  snapgit keep <branch>                                       save to memories (remove the timer)
  snapgit sweep [--remote origin] [--dry-run] [--quiet]       delete expired branches, merge due PRs
  snapgit watch [--remote origin] [--every 5s]                keep sweeping, so fuses burn on time
  snapgit init                                                install hooks so sweeping is automatic

  snapgit pr send [branch] [--base main] [-m "title\\nbody"] [--ttl 24h] [--remote origin]
  snapgit pr open <id> [--remote origin]                      read once, then it's gone
  snapgit pr ls [--remote origin]                             unopened PRs
  snapgit pr burn <id> [--remote origin]                      retract without reading

  snapgit pr receipts [--remote origin]                       who opened (or screenshotted) your PRs; read once

  snapgit streak                                              your commit streak
  snapgit story [--since 24h]                                 your last day in git, then it's gone
`;

const paint = (code, s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (s = '') => process.stdout.write(s + '\n');
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

export async function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  try {
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

function printSweep({ ghosted, skipped, events }, quiet, dryRun) {
  for (const e of events) {
    if (e.action === 'merged') {
      out(`🔀 PR ${e.id}: nobody rejected it, so ${e.head} merged into ${e.base}${e.late ? ' (a rejection arrived too late)' : ''}${e.pushed ? ' and was pushed' : ''}`);
    } else if (e.action === 'rejected') {
      out(`🚫 PR ${e.id} rejected by ${e.by}${e.reason ? `: "${e.reason}"` : ''}. Nothing merged`);
    }
  }
  for (const g of ghosted) {
    out(`👻 ${dryRun ? 'would ghost' : 'ghosted'} ${g.name} (was ${g.sha}${g.remote ? ', remote too' : ''}). Undo: git branch ${g.name} ${g.sha}`);
  }
  if (!quiet) for (const s of skipped) out(`   kept ${s.name}: ${s.reason}`);
  if (!quiet && !ghosted.length && !skipped.length && !events.length) out('nothing has expired');
}

const prForBranchId = (id, cwd) => listLocalPrs(cwd).some((r) => r.id === id);

const COMMANDS = {
  snap(argv, cwd) {
    const { values, positionals } = args(argv, { ...TTL, from: { type: 'string' }, stay: { type: 'boolean' } });
    if (positionals.length !== 1) throw new Error('usage: snapgit snap <branch> [--ttl 24h]');
    const ttlMs = parseDuration(values.ttl ?? '24h');
    const expiresAt = createSnap(positionals[0], { ttlMs, from: values.from, stay: values.stay, cwd });
    out(`📸 ${positionals[0]} will disappear in ${formatDuration(ttlMs)} (${when(expiresAt)}). Commit fast.`);
  },

  ls(argv, cwd) {
    sweepQuiet(cwd);
    const snaps = listSnaps(cwd);
    if (!snaps.length) return out('no branches on the clock. snapgit snap <name> to start one');
    for (const s of snaps) {
      const left = s.expiresAt - now();
      out(`${s.name.padEnd(30)} ${s.tip}  ${left > 0 ? paint(33, formatDuration(left) + ' left') : paint(31, 'expired, awaiting sweep')}`);
    }
  },

  extend(argv, cwd) {
    const { positionals } = args(argv, {});
    if (positionals.length !== 2) throw new Error('usage: snapgit extend <branch> <duration>');
    const [name, dur] = positionals;
    const current = getExpiry(name, cwd);
    if (current === null) throw new Error(`${name} is not on the clock`);
    if (current <= now()) throw new Error(`${name} already expired; it is too late for extensions`);
    const next = current + parseDuration(dur);
    setExpiry(name, next, cwd);
    retimePr(name, next, cwd);
    out(`⏳ ${name} now disappears ${when(next)}`);
  },

  keep(argv, cwd) {
    const { positionals } = args(argv, {});
    if (positionals.length !== 1) throw new Error('usage: snapgit keep <branch>');
    const pending = prForBranch(positionals[0], cwd);
    if (pending) throw new Error(`${positionals[0]} has a live PR (${pending.id}): reject it or withdraw it with snapgit pr burn, otherwise it merges when the branch expires`);
    if (!clearExpiry(positionals[0], cwd)) throw new Error(`${positionals[0]} is not on the clock`);
    out(`💾 ${positionals[0]} saved to memories. It will not disappear.`);
  },

  sweep(argv, cwd) {
    const { values } = args(argv, {
      remote: { type: 'string', short: 'r' },
      'dry-run': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      offline: { type: 'boolean' },
    }, false);
    const dryRun = values['dry-run'];
    const result = sweep({ cwd, remote: values.remote, dryRun, settle: () => settlePrs({ cwd, push: !!values.remote, offline: values.offline }) });
    printSweep(result, values.quiet, dryRun);
    if (!dryRun) {
      for (const id of sweepPrs(cwd)) out(`💨 PR ${id} dropped: its branch is gone, nothing to merge`);
    }
  },

  async watch(argv, cwd) {
    const { values } = args(argv, { remote: { type: 'string', short: 'r' }, every: { type: 'string' } }, false);
    const everyMs = parseDuration(values.every ?? '5s');
    out(`👀 watching every ${formatDuration(everyMs)}${values.remote ? ` (remote ${values.remote})` : ''}. Ctrl-C to stop`);
    for (;;) {
      printSweep(sweep({ cwd, remote: values.remote, settle: () => settlePrs({ cwd, push: !!values.remote }) }), true, false);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  },

  init(argv, cwd) {
    const installed = installHooks(cwd);
    out(installed.length ? `hooks installed: ${installed.join(', ')}. Expired branches now vanish on their own.` : 'hooks already installed');
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
      const due = Math.min(p.expiresAt, rc ? rc.openedAt + fuseMs() : Infinity);
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
      const { values, positionals } = args(rest, { ...remoteOpt, ...TTL, base: { type: 'string', short: 'b' }, message: { type: 'string', short: 'm' } });
      const remote = values.remote;
      if (remote && !hasRemote(remote, cwd)) throw new Error(`no remote named ${remote}`);
      const rec = createPr({ cwd, head: positionals[0], base: values.base, message: values.message, ttlMs: parseDuration(values.ttl ?? '24h'), remote });
      out(`📨 sent "${rec.title}" (${rec.head} -> ${rec.base})`);
      out(`   id ${rec.id}, 60 seconds after it is first opened (or at ${when(rec.expiresAt)}), it merges into ${rec.base} unless rejected`);
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
      const remote = values.remote ?? (hasRemote('origin', cwd) ? 'origin' : undefined);
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
    if (sub === 'ls') {
      const { values } = args(rest, remoteOpt, false);
      const local = listLocalPrs(cwd);
      for (const r of local) {
        const rc = receiptFor(r.id, cwd);
        const due = Math.min(r.expiresAt, rc ? rc.openedAt + fuseMs() : Infinity);
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
    if (sub === 'burn') {
      const { values, positionals } = args(rest, remoteOpt);
      if (positionals.length !== 1) throw new Error('usage: snapgit pr burn <id>');
      if (!burnPr(positionals[0], { cwd, remote: values.remote })) throw new Error(`PR ${positionals[0]} not found`);
      out('🔥 burned');
      return;
    }
    throw new Error('usage: snapgit pr <send|open|reject|ls|receipts|burn>');
  },
};

function sweepQuiet(cwd) {
  printSweep(sweep({ cwd, settle: () => settlePrs({ cwd, offline: true }) }), true, false);
  sweepPrs(cwd);
}

function render(r, receipt, mergesAt, screenshot) {
  const bar = '━'.repeat(60);
  out(paint(35, bar));
  out(`${paint(1, r.title)}   ${paint(2, `#${r.id}`)}`);
  out(`${r.author}  ·  ${r.head} -> ${r.base}  ·  sent ${when(r.createdAt)}`);
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
