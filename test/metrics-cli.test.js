import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { T0, HOUR, sh, git, snap, repo, commit, branches, mainHas, openIt, remotes, writePolicy } from './helpers.js';

const DONE = T0 + 61_000;
const out = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
const metrics = (dir, ...a) => snap(dir, ['metrics', ...a], T0 + 2 * HOUR);

/** A branch off main with one new file (and an optional commit message). */
function branchOff(dir, name, file = `${name}.txt`, msg = `work on ${name}`) {
  git(dir, 'switch', '-q', '-c', name, 'main');
  writeFileSync(join(dir, file), `${name}\n`);
  git(dir, 'add', '.');
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', msg]).status, 0);
  git(dir, 'switch', '-q', 'main');
}
const send = (dir, name, extra = []) => snap(dir, ['pr', 'send', name, '--ttl', '1h', ...extra]);
const idOf = (r) => r.stdout.match(/id ([0-9a-f]{8})/)[1];

function seeded() {
  const dir = repo();
  writePolicy(dir, {
    teams: { platform: ['test@example.com'] },
    checks: [{ name: 'no-shame-file', run: `node -e "process.exit(require('fs').existsSync('shame.txt')?1:0)"` }],
  });
  branchOff(dir, 'feat-a');
  branchOff(dir, 'feat-b', undefined, 'agent work\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>');
  branchOff(dir, 'feat-c');
  branchOff(dir, 'feat-d', 'shame.txt');
  branchOff(dir, 'feat-e');
  const a = idOf(send(dir, 'feat-a'));
  const b = idOf(send(dir, 'feat-b'));
  out(send(dir, 'feat-c'));
  const shamed = send(dir, 'feat-d');
  assert.equal(shamed.status, 1);
  const e = idOf(send(dir, 'feat-e'));
  openIt(dir, a);
  openIt(dir, b);
  out(snap(dir, ['pr', 'reject', b, '-m', 'no']));
  out(snap(dir, ['pr', 'burn', e]));
  snap(dir, ['sweep'], DONE); // a merges, b is rejected
  snap(dir, ['sweep'], T0 + 2 * HOUR); // c expires unopened; d's branch is deleted
  return { dir, a, b, e };
}

test('every kind of ending leaves an outcome, with a team and an agent flag but no person', () => {
  const { dir } = seeded();
  const s = JSON.parse(out(metrics(dir, '--json', '--since', '7d')));
  assert.deepEqual([s.stats.merged, s.stats.rejected, s.stats.expired, s.stats.shamed, s.stats.withdrawn], [1, 1, 1, 1, 1]);
  assert.equal(s.total, 4); // withdrawn PRs are not outcomes of review
  assert.deepEqual(s.teams.map((t) => [t.team, t.suppressed, t.merged]), [['platform', undefined, 1]]);
  assert.equal(s.populations.agent.suppressed, true); // one agent PR: too few to show
  assert.equal(s.populations.human.suppressed, undefined);
});

test('the raw outcome holds no author, title or branch, only timings, size, team and agent flag', () => {
  const { dir, a } = seeded();
  const raw = JSON.parse(git(dir, 'cat-file', 'blob', git(dir, 'rev-parse', `refs/snapgit/outcome/${a}`)));
  assert.deepEqual(Object.keys(raw).sort(), ['agent', 'createdAt', 'fuseMs', 'id', 'kind', 'lines', 'openedAt', 'settledAt', 'src', 'team', 'undone', 'v', 'validatedAt']);
  assert.equal(raw.team, 'platform');
  assert.equal(raw.kind, 'merged');
  assert.equal(raw.settledAt - raw.openedAt, 61_000); // settled by the sweep that ran a second after the fuse
  const text = JSON.stringify(raw);
  assert.doesNotMatch(text, /test@example\.com|feat-a|work on/);
});

test('agent-authored PRs are flagged from Co-Authored-By trailers', () => {
  const { dir, b } = seeded();
  const raw = JSON.parse(git(dir, 'cat-file', 'blob', git(dir, 'rev-parse', `refs/snapgit/outcome/${b}`)));
  assert.equal(raw.agent, true);
  assert.equal(raw.kind, 'rejected');
});

test('the terminal report reads well and refuses to show tiny groups', () => {
  const { dir } = seeded();
  const r = out(metrics(dir, '--since', '7d'));
  assert.match(r, /snapgit metrics, last 7d: 4 settled PRs/);
  assert.match(r, /merged 25%.*expired unopened 25%.*failed CI 25%/);
  assert.match(r, /time to merge: median 1m/);
  assert.match(r, /human: 3 PRs, merged 33%/);
  assert.match(r, /agent: fewer than 3 PRs, not shown/); // one agent PR must not be singled out
  assert.match(r, /platform: 4 PRs, merged 25%/);
  assert.match(r, /Only 4 settled PRs/);
  assert.match(r, /No baseline here/);
});

test('--csv holds aggregates only; --records holds anonymous rows', () => {
  const { dir } = seeded();
  const agg = out(metrics(dir, '--csv', '--since', '7d'));
  assert.match(agg.split('\n')[0], /^section,name,n,merged,rejected,expired,shamed,median_cycle_ms$/);
  assert.match(agg, /population,agent,<3/);
  const rec = out(metrics(dir, '--records', '--since', '7d'));
  assert.equal(rec.trim().split('\n').length, 1 + 5);
  assert.doesNotMatch(rec, /test@example|feat-/);
});

test('undo marks the outcome undone, which the report shows as the undo rate', () => {
  const { dir, a } = seeded();
  out(snap(dir, ['undo', a], T0 + 2 * HOUR));
  const s = JSON.parse(out(metrics(dir, '--json', '--since', '7d')));
  assert.equal(s.stats.undoRate, 1);
});

test('outcomes travel through the remote: another machine reports the same numbers; --publish feeds the dashboard', () => {
  const dir = repo();
  const { bare, sender, clone } = remotes({ sender: dir, setup: (s) => { branchOff(s, 'feat'); git(s, 'switch', '-q', 'feat'); } });
  const id = idOf(snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']));
  openIt(clone('Alice'), id);
  snap(sender, ['sweep', '-r', 'origin'], DONE);
  assert.ok(mainHas(sender, 'feat.txt'));
  assert.match(git(bare, 'ls-remote', '.', 'refs/snapgit/outcome/*'), new RegExp(id));

  const other = clone('Ops'); // never saw the PR
  const s = JSON.parse(out(snap(other, ['metrics', '-r', 'origin', '--json', '--since', '30d'], T0 + 2 * HOUR)));
  assert.equal(s.stats.merged, 1);

  assert.match(out(snap(sender, ['metrics', '--publish', '-r', 'origin'], T0 + 2 * HOUR)), /published 1 outcomes to origin\/snapgit-metrics/);
  const published = JSON.parse(git(bare, 'show', 'snapgit-metrics:outcomes.json'));
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'merged');
});

test('metrics on a repo with no history says so, and bad options fail clearly', () => {
  const dir = repo();
  assert.match(out(metrics(dir)), /0 settled PRs[\s\S]*nothing settled/);
  assert.match(metrics(dir, '--population', 'robots').stderr, /--population is all, human or agent/);
  assert.match(snap(dir, ['metrics', '--publish'], T0).stderr, /needs a remote/);
});
