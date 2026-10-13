import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, median, fmtDuration, normalizeOutcome, normalizePull, filterRecords, groupStats, summarize, insights, recordsCsv, aggregatesCsv, demoRecords, DAY } from '../web/lib/metrics.js';

const T = Date.UTC(2026, 2, 2, 12); // a Monday noon
const rec = (o) => normalizeOutcome({ id: 'x', src: 'gh', kind: 'merged', createdAt: T, settledAt: T + 3600_000, lines: 10, fuseMs: 15_000, agent: false, ...o });

test('percentile and median interpolate; empty is null', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 46);
});

test('durations read like a person', () => {
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(31 * 60_000), '31m');
  assert.equal(fmtDuration(125 * 60_000), '2h 5m');
  assert.equal(fmtDuration(3 * DAY + 4 * 3600_000), '3d 4h');
  assert.equal(fmtDuration(null), 'n/a');
});

test('outcomes are validated and normalised; garbage is dropped', () => {
  assert.equal(normalizeOutcome(null), null);
  assert.equal(normalizeOutcome({ kind: 'merged', createdAt: 5, settledAt: 4 }), null); // time travel
  assert.equal(normalizeOutcome({ kind: 'party', createdAt: 1, settledAt: 2 }), null);
  assert.equal(normalizeOutcome({ kind: 'merged', createdAt: 'x', settledAt: 2 }), null);
  const r = rec({ team: 'platform', agent: 1, undone: true, openedAt: T + 1000 });
  assert.deepEqual([r.team, r.agent, r.undone, r.openedAt, r.baseline], ['platform', true, true, T + 1000, false]);
  assert.equal(rec({ team: '' }).team, null);
});

test('GitHub pulls become baseline records; snapgit-handled and open ones do not', () => {
  const pull = (o) => ({ number: 1, created_at: '2026-03-02T00:00:00Z', closed_at: '2026-03-04T00:00:00Z', merged_at: '2026-03-04T00:00:00Z', labels: [], user: { type: 'User' }, ...o });
  const b = normalizePull(pull());
  assert.equal(b.kind, 'merged');
  assert.equal(b.baseline, true);
  assert.equal(b.settledAt - b.createdAt, 2 * DAY);
  assert.equal(normalizePull(pull({ merged_at: null })).kind, 'closed');
  assert.equal(normalizePull(pull({ closed_at: null, merged_at: null })), null);
  assert.equal(normalizePull(pull({ labels: [{ name: 'snapgit:merged' }] })), null);
  assert.equal(normalizePull(pull({ user: { type: 'Bot' } })).agent, true);
});

test('group stats: rates use the right denominators', () => {
  const rs = [
    rec({ kind: 'merged', openedAt: T, undone: true }), rec({ kind: 'merged', openedAt: T }), rec({ kind: 'merged', openedAt: T }),
    rec({ kind: 'rejected', openedAt: T }), rec({ kind: 'expired' }), rec({ kind: 'shamed' }), rec({ kind: 'withdrawn' }),
  ];
  const g = groupStats(rs);
  assert.equal(g.n, 6); // withdrawals are not outcomes of review
  assert.equal(g.mergeRate, 3 / 6);
  assert.equal(g.rejectRate, 1 / 4); // only of PRs a reviewer actually opened
  assert.equal(g.expiredRate, 1 / 6);
  assert.equal(g.shameRate, 1 / 6);
  assert.equal(g.undoRate, 1 / 3);
  assert.equal(g.p50, 3600_000);
});

test('summarize: stage breakdown, weekly buckets, baseline comparison', () => {
  const snap = Array.from({ length: 6 }, (_, i) => rec({
    id: `s${i}`, createdAt: T + i * DAY, validatedAt: T + i * DAY + 600_000, openedAt: T + i * DAY + 600_000 + 7200_000,
    settledAt: T + i * DAY + 600_000 + 7200_000 + 60_000, fuseMs: 60_000,
  }));
  const base = Array.from({ length: 6 }, (_, i) => normalizePull({
    number: i, created_at: new Date(T - 9 * DAY + i * 0.5 * DAY).toISOString(), closed_at: new Date(T - 7 * DAY + i * 0.5 * DAY).toISOString(),
    merged_at: new Date(T - 7 * DAY + i * 0.5 * DAY).toISOString(), labels: [], user: { type: 'User' },
  }));
  const s = summarize([...snap, ...base], { since: T - DAY, until: T + 8 * DAY, baselineMode: 'before' });
  assert.equal(s.total, 6);
  assert.equal(s.breakdown.ci, 600_000);
  assert.equal(s.breakdown.reviewer, 7200_000);
  assert.equal(s.breakdown.fuse, 60_000);
  assert.equal(s.baseline.p50, 2 * DAY);
  assert.equal(s.baseline.label, 'PRs before snapgit');
  assert.ok(s.delta.p50 < -0.9); // ~2h11m against 2 days
  assert.equal(s.weekly.reduce((n, w) => n + w.merged, 0), 6);
  assert.ok(s.weekly.every((w) => new Date(w.week).getUTCDay() === 1)); // weeks start on Monday
  const same = summarize([...snap, ...base], { since: T - 30 * DAY, until: T + 8 * DAY, baselineMode: 'same' });
  assert.equal(same.baseline.label, 'PRs that skipped snapgit');
  assert.equal(same.baseline.n, 6);
});

test('small groups are suppressed so nobody can be singled out', () => {
  const mk = (team, n, agent = false) => Array.from({ length: n }, (_, i) => rec({ id: `${team}${i}`, team, agent }));
  const s = summarize([...mk('platform', 5), ...mk('payments', 2), ...mk('mobile', 4, true)], { since: T - DAY, until: T + 2 * DAY });
  const byName = Object.fromEntries(s.teams.map((t) => [t.team, t]));
  assert.equal(byName.platform.suppressed, undefined);
  assert.equal(byName.payments.suppressed, true);
  assert.equal(byName.payments.merged, undefined, 'no numbers leak for a suppressed group');
  assert.equal(s.populations.agent.suppressed, undefined); // 4 agent PRs >= 3
  const strict = summarize([...mk('platform', 5)], { since: T - DAY, until: T + 2 * DAY, minGroup: 10 });
  assert.equal(strict.teams[0].suppressed, true);
  assert.match(aggregatesCsv(s), /team,payments,<3,,,,,/);
});

test('filters scope the population and team', () => {
  const rs = [rec({ agent: true, team: 'a' }), rec({ agent: false, team: 'a' }), rec({ agent: false, team: 'b' })];
  assert.equal(filterRecords(rs, { population: 'agent' }).length, 1);
  assert.equal(filterRecords(rs, { population: 'human' }).length, 2);
  assert.equal(filterRecords(rs, { team: 'b' }).length, 1);
  assert.equal(filterRecords(rs, { since: T + 7200_000 }).length, 0);
});

test('insights are honest: small samples are flagged, expired share sits beside the cycle time', () => {
  const few = summarize([rec({ id: 'a' }), rec({ id: 'b' })], { since: T - DAY, until: T + DAY });
  assert.match(insights(few)[0].text, /Only 2 settled PRs/);

  const demo = demoRecords(T + 60 * DAY);
  const s = summarize(demo, { since: T + 5 * DAY, until: T + 60 * DAY, baselineMode: 'before' });
  const texts = insights(s).map((i) => i.text).join('\n');
  assert.match(texts, /Median time to merge is .* against .* for prs before snapgit/i);
  assert.match(texts, /Expired PRs are not in that number/);
  assert.match(texts, /expired unopened/);
});

test('CSV exports are anonymous: no author, title or branch columns', () => {
  const csv = recordsCsv([rec({ team: 'platform' })]);
  assert.match(csv.split('\n')[0], /^id,source,kind,created,validated,opened,settled,lines,fuse_ms,agent,team,undone$/);
  assert.doesNotMatch(csv.split('\n')[0], /author|title|branch|login/);
  assert.match(csv, /platform/);
});

test('the demo data is deterministic, plausible and sized for the dashboard', () => {
  const a = demoRecords(1_800_000_000_000);
  const b = demoRecords(1_800_000_000_000);
  assert.deepEqual(a, b);
  assert.ok(a.filter((r) => r.baseline).length > 100 && a.filter((r) => !r.baseline).length > 200);
  for (const r of a) assert.ok(r.settledAt >= r.createdAt, r.id);
  const s = summarize(a, { since: 1_800_000_000_000 - 56 * DAY, until: 1_800_000_000_000 });
  assert.ok(s.stats.p50 < s.baseline.p50, 'snapgit demo is faster than baseline, by construction');
  assert.ok(s.teams.length === 4 && s.teams.every((t) => !t.suppressed));
});
