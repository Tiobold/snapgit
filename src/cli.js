import { parseArgs } from 'node:util';
import { hasRemote, run } from './git.js';
import { parseDuration, formatDuration, now } from './time.js';
import { createSnap, listSnaps, setExpiry, getExpiry, clearExpiry, sweep } from './snaps.js';
import { createPr, openPr, burnPr, listLocalPrs, listRemotePrIds, sweepPrs } from './pr.js';
import { streak } from './streak.js';
import { installHooks } from './hooks.js';

const HELP = `snapgit: git, but it disappears

  snapgit snap <branch> [--ttl 24h] [--from <ref>] [--stay]   new branch with a self-destruct timer
  snapgit ls                                                  branches on the clock
  snapgit extend <branch> <duration>                          buy more time (e.g. 12h)
  snapgit keep <branch>                                       save to memories (remove the timer)
  snapgit sweep [--remote origin] [--dry-run] [--quiet]       delete expired branches and PRs
  snapgit init                                                install hooks so sweeping is automatic

  snapgit pr send [branch] [--base main] [-m "title\\nbody"] [--ttl 24h] [--remote origin]
  snapgit pr open <id> [--remote origin]                      read once, then it's gone
  snapgit pr ls [--remote origin]                             unopened PRs
  snapgit pr burn <id> [--remote origin]                      retract without reading

  snapgit streak                                              your commit streak
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

function printSweep({ ghosted, skipped }, quiet, dryRun) {
  for (const g of ghosted) {
    out(`👻 ${dryRun ? 'would ghost' : 'ghosted'} ${g.name} (was ${g.sha}${g.remote ? ', remote too' : ''}). Undo: git branch ${g.name} ${g.sha}`);
  }
  if (!quiet) for (const s of skipped) out(`   kept ${s.name}: ${s.reason}`);
  if (!quiet && !ghosted.length && !skipped.length) out('nothing has expired');
}

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
    out(`⏳ ${name} now disappears ${when(next)}`);
  },

  keep(argv, cwd) {
    const { positionals } = args(argv, {});
    if (positionals.length !== 1) throw new Error('usage: snapgit keep <branch>');
    if (!clearExpiry(positionals[0], cwd)) throw new Error(`${positionals[0]} is not on the clock`);
    out(`💾 ${positionals[0]} saved to memories. It will not disappear.`);
  },

  sweep(argv, cwd) {
    const { values } = args(argv, {
      remote: { type: 'string', short: 'r' },
      'dry-run': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
    }, false);
    const dryRun = values['dry-run'];
    const result = sweep({ cwd, remote: values.remote, dryRun });
    printSweep(result, values.quiet, dryRun);
    if (!dryRun) {
      for (const id of sweepPrs(cwd)) out(`💨 PR ${id} expired unopened`);
    }
  },

  init(argv, cwd) {
    const installed = installHooks(cwd);
    out(installed.length ? `hooks installed: ${installed.join(', ')}. Expired branches now vanish on their own.` : 'hooks already installed');
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
      out(`   id ${rec.id}, view once, expires ${when(rec.expiresAt)}`);
      out(remote ? `   recipient: snapgit pr open ${rec.id} -r ${remote}` : `   not pushed anywhere yet; use --remote <name> to deliver it`);
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
      const { record, expired } = openPr(positionals[0], { cwd, remote });
      if (expired) throw new Error(`PR ${record.id} expired before you opened it. It is gone now`);
      render(record, screenshot);
      return;
    }
    if (sub === 'ls') {
      const { values } = args(rest, remoteOpt, false);
      const local = listLocalPrs(cwd);
      for (const r of local) out(`${r.id}  ${r.title}  (${r.head} -> ${r.base}, ${formatDuration(r.expiresAt - now())} left)`);
      if (values.remote) {
        const seen = new Set(local.map((r) => r.id));
        for (const id of listRemotePrIds(values.remote, cwd)) if (!seen.has(id)) out(`${id}  unopened, waiting on ${values.remote}`);
      }
      if (!local.length && !values.remote) out('no pending PRs');
      return;
    }
    if (sub === 'burn') {
      const { values, positionals } = args(rest, remoteOpt);
      if (positionals.length !== 1) throw new Error('usage: snapgit pr burn <id>');
      if (!burnPr(positionals[0], { cwd, remote: values.remote })) throw new Error(`PR ${positionals[0]} not found`);
      out('🔥 burned');
      return;
    }
    throw new Error('usage: snapgit pr <send|open|ls|burn>');
  },
};

function sweepQuiet(cwd) {
  printSweep(sweep({ cwd }), true, false);
  sweepPrs(cwd);
}

function render(r, screenshot) {
  const bar = '━'.repeat(60);
  out(paint(35, bar));
  out(`${paint(1, r.title)}   ${paint(2, `#${r.id}, view once`)}`);
  out(`${r.author}  ·  ${r.head} -> ${r.base}  ·  sent ${when(r.createdAt)}`);
  if (r.message) out(`\n${r.message}`);
  if (r.commits.length) out(`\n${r.commits.map((c) => '  ' + c).join('\n')}`);
  out(`\n${r.stat}\n`);
  for (const line of r.patch.trimEnd().split('\n')) {
    out(line.startsWith('+') && !line.startsWith('+++') ? paint(32, line) : line.startsWith('-') && !line.startsWith('---') ? paint(31, line) : line);
  }
  out(paint(35, bar));
  out('💥 this PR has self-destructed. You will not see it again.');
  if (screenshot) out('📸 screenshot detected (nobody was notified, we have no servers)');
}
