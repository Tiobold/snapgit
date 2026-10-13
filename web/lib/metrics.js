// snapgit metrics: pure functions, no DOM, no network. Shared by the dashboard page, the CLI (`snapgit metrics`)
// and the Action (which writes the outcomes this module reads).
//
// An *outcome* is what happened to one PR, recorded when it settled:
//   { v: 1, id, src: 'cli' | 'gh', kind: 'merged' | 'rejected' | 'expired' | 'shamed' | 'withdrawn',
//     createdAt, validatedAt?, openedAt?, settledAt, lines, fuseMs, agent, team?, undone? }
// Outcomes carry a team and an "agent-authored" flag, never a person: the dashboard answers "how does review
// work here", not "who is slow".

export const DAY = 864e5;
export const KINDS = ['merged', 'rejected', 'expired', 'shamed'];
const ALL_KINDS = new Set([...KINDS, 'withdrawn']);
export const DEFAULT_MIN_GROUP = 3;

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (values) => percentile(values, 0.5);

/** 45s, 31m, 2h 5m, 3d 4h. null/NaN -> an em-free placeholder. */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  let s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const parts = [];
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60]]) {
    const n = Math.floor(s / size);
    s -= n * size;
    if (n > 0) parts.push(`${n}${label}`);
  }
  return parts.slice(0, 2).join(' ');
}

export const pct = (x) => (x === null || !Number.isFinite(x) ? 'n/a' : `${Math.round(x * 100)}%`);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A stored outcome -> a clean record, or null if it is not usable. */
export function normalizeOutcome(o) {
  if (!o || !ALL_KINDS.has(o.kind)) return null;
  const createdAt = num(o.createdAt);
  const settledAt = num(o.settledAt);
  if (createdAt === null || settledAt === null || settledAt < createdAt) return null;
  return {
    id: String(o.id), src: o.src === 'gh' ? 'gh' : 'cli', kind: o.kind, createdAt, settledAt,
    validatedAt: num(o.validatedAt), openedAt: num(o.openedAt), lines: num(o.lines) ?? 0, fuseMs: num(o.fuseMs),
    agent: !!o.agent, team: typeof o.team === 'string' && o.team ? o.team : null, undone: !!o.undone, baseline: false,
  };
}

/**
 * A closed pull request from GitHub's list API that snapgit did NOT handle -> a baseline record.
 * PRs snapgit handled (labelled snapgit:*) are represented by outcomes instead. Open PRs are not records yet.
 */
export function normalizePull(p) {
  if (!p || !p.closed_at) return null;
  if ((p.labels ?? []).some((l) => String(l.name ?? l).startsWith('snapgit:'))) return null;
  const createdAt = Date.parse(p.created_at);
  const settledAt = Date.parse(p.merged_at ?? p.closed_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(settledAt) || settledAt < createdAt) return null;
  return {
    id: `pr-${p.number}`, src: 'gh', kind: p.merged_at ? 'merged' : 'closed', createdAt, settledAt, validatedAt: null, openedAt: null,
    lines: 0, fuseMs: null, agent: p.user?.type === 'Bot', team: null, undone: false, baseline: true,
  };
}

/** Records settled inside [since, until], optionally for one population ('human' | 'agent') and/or team. */
export function filterRecords(records, { since = -Infinity, until = Infinity, population = 'all', team = null } = {}) {
  return records.filter((r) => r.settledAt >= since && r.settledAt <= until
    && (population === 'all' || (population === 'agent') === r.agent)
    && (!team || r.team === team));
}

const mondayOf = (ms) => {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
};

/** Stats for one group of snapgit outcomes. */
export function groupStats(recs) {
  const by = (k) => recs.filter((r) => r.kind === k);
  const merged = by('merged');
  const rejected = by('rejected');
  const settled = recs.filter((r) => r.kind !== 'withdrawn');
  const cycle = merged.map((r) => r.settledAt - r.createdAt);
  const opened = merged.length + rejected.length; // PRs a reviewer actually looked at and decided on
  return {
    n: settled.length,
    merged: merged.length, rejected: rejected.length, expired: by('expired').length, shamed: by('shamed').length, withdrawn: by('withdrawn').length,
    mergeRate: settled.length ? merged.length / settled.length : null,
    rejectRate: opened ? rejected.length / opened : null, // of the PRs someone opened, how many did they veto
    expiredRate: settled.length ? by('expired').length / settled.length : null,
    shameRate: settled.length ? by('shamed').length / settled.length : null,
    undoRate: merged.length ? merged.filter((r) => r.undone).length / merged.length : null,
    p50: median(cycle), p75: percentile(cycle, 0.75), p90: percentile(cycle, 0.9),
  };
}

/**
 * The whole dashboard in one object.
 *  records: normalized outcomes AND baseline records, together.
 *  Groups smaller than minGroup are suppressed, so nobody can be singled out of a table.
 */
export function summarize(records, { since, until, population = 'all', team = null, minGroup = DEFAULT_MIN_GROUP, baselineMode = 'before' } = {}) {
  const snap = records.filter((r) => !r.baseline);
  const base = records.filter((r) => r.baseline);
  const inWin = filterRecords(snap, { since, until });
  const scoped = filterRecords(snap, { since, until, population, team });
  const stats = groupStats(scoped);

  // Time to merge, split into the stages a PR passes through.
  const merged = scoped.filter((r) => r.kind === 'merged' && r.openedAt !== null);
  const stage = (f) => median(merged.map(f).filter((v) => v >= 0));
  const breakdown = {
    n: merged.length,
    ci: stage((r) => (r.validatedAt ?? r.createdAt) - r.createdAt),
    reviewer: stage((r) => r.openedAt - (r.validatedAt ?? r.createdAt)),
    fuse: stage((r) => r.settledAt - r.openedAt),
  };

  // Weekly outcomes, zero-filled so gaps are visible as gaps.
  const weekly = [];
  if (scoped.length) {
    const first = mondayOf(since ?? Math.min(...scoped.map((r) => r.settledAt)));
    const last = mondayOf(until ?? Math.max(...scoped.map((r) => r.settledAt)));
    for (let w = first; w <= last; w += 7 * DAY) weekly.push({ week: w, merged: 0, rejected: 0, expired: 0, shamed: 0 });
    for (const r of scoped) {
      const row = weekly.find((x) => x.week === mondayOf(r.settledAt));
      if (row && KINDS.includes(r.kind)) row[r.kind]++;
    }
  }

  // Baseline: what normal (non-snapgit) PRs cost. "before" = an equal-length window before snapgit's first PR.
  const adoptionAt = snap.length ? Math.min(...snap.map((r) => r.createdAt)) : null;
  let baseRecs;
  let baselineLabel;
  if (baselineMode === 'before' && adoptionAt !== null && Number.isFinite(since) && Number.isFinite(until)) {
    baseRecs = filterRecords(base, { since: adoptionAt - (until - since), until: adoptionAt, population });
    baselineLabel = 'PRs before snapgit';
  } else {
    baseRecs = filterRecords(base, { since, until, population });
    baselineLabel = 'PRs that skipped snapgit';
  }
  const baseCycle = baseRecs.filter((r) => r.kind === 'merged').map((r) => r.settledAt - r.createdAt);
  const baseline = {
    label: baselineLabel, n: baseRecs.length, merged: baseCycle.length, abandoned: baseRecs.length - baseCycle.length,
    p50: median(baseCycle), p75: percentile(baseCycle, 0.75), p90: percentile(baseCycle, 0.9),
  };
  const change = (a, b) => (a !== null && b !== null && b > 0 ? (a - b) / b : null);
  const delta = { p50: change(stats.p50, baseline.p50), p75: change(stats.p75, baseline.p75), p90: change(stats.p90, baseline.p90) };

  // Population split and team table, with small groups suppressed.
  const group = (recs) => {
    const settled = recs.filter((r) => r.kind !== 'withdrawn').length;
    return settled >= minGroup ? groupStats(recs) : { n: settled, suppressed: true };
  };
  const populations = {
    human: group(filterRecords(snap, { since, until, population: 'human', team })),
    agent: group(filterRecords(snap, { since, until, population: 'agent', team })),
  };
  const teamNames = [...new Set(inWin.map((r) => r.team).filter(Boolean))].sort();
  const teams = teamNames.map((t) => ({ team: t, ...group(filterRecords(snap, { since, until, population, team: t })) }));
  const untagged = inWin.filter((r) => !r.team && (population === 'all' || (population === 'agent') === r.agent));

  return { since, until, population, team, minGroup, total: stats.n, stats, breakdown, weekly, baseline, delta, adoptionAt, populations, teams, untaggedN: untagged.length };
}

const STAGES = { ci: 'waiting for CI', reviewer: 'waiting for a reviewer', fuse: 'the fuse' };

/** Plain-language findings, each with the number behind it and honest caveats. */
export function insights(s) {
  const out = [];
  const st = s.stats;
  if (s.total === 0) return [{ tone: 'note', text: 'No settled PRs in this window yet.' }];
  if (s.total < 30) out.push({ tone: 'caution', text: `Only ${s.total} settled PRs in this window: treat every percentage below as a hint, not a result.` });

  if (st.p50 !== null && s.baseline.p50 !== null && s.delta.p50 !== null) {
    const faster = s.delta.p50 < 0;
    out.push({
      tone: faster ? 'good' : 'caution',
      text: `Median time to merge is ${fmtDuration(st.p50)} against ${fmtDuration(s.baseline.p50)} for ${s.baseline.label} (${faster ? '' : '+'}${Math.round(s.delta.p50 * 100)}%). Expired PRs are not in that number, so read it with the expired share.`,
    });
  } else if (st.p50 !== null) {
    out.push({ tone: 'note', text: `Median time to merge is ${fmtDuration(st.p50)}. There is no baseline of ordinary PRs in this window to compare it with.` });
  }
  if (st.expiredRate !== null && st.expiredRate >= 0.1) {
    out.push({ tone: 'caution', text: `${pct(st.expiredRate)} of PRs expired unopened: nobody looked, so they were deleted. That is the review queue, made visible.` });
  } else if (st.expiredRate !== null) {
    out.push({ tone: 'good', text: `Only ${pct(st.expiredRate)} of PRs expired unopened: reviewers are getting to nearly everything.` });
  }
  const b = s.breakdown;
  if (b.n >= 5) {
    const top = Object.entries({ ci: b.ci, reviewer: b.reviewer, fuse: b.fuse }).filter(([, v]) => v !== null).sort((x, y) => y[1] - x[1])[0];
    if (top) out.push({ tone: 'note', text: `For merged PRs the longest stage is ${STAGES[top[0]]} (median ${fmtDuration(top[1])}).` });
  }
  if (st.shameRate !== null && st.shameRate > 0) out.push({ tone: 'note', text: `${pct(st.shameRate)} of PRs failed CI before anyone had to review them.` });
  const h = s.populations.human;
  const a = s.populations.agent;
  if (!h.suppressed && !a.suppressed && h.shameRate !== null && a.shameRate !== null && Math.abs(a.shameRate - h.shameRate) >= 0.1) {
    out.push({ tone: 'note', text: `Agent-authored PRs fail CI ${a.shameRate > h.shameRate ? 'more' : 'less'} often than human ones (${pct(a.shameRate)} vs ${pct(h.shameRate)}).` });
  }
  if (st.rejectRate !== null && st.merged + st.rejected >= 5) out.push({ tone: 'note', text: `Reviewers rejected ${pct(st.rejectRate)} of the PRs they opened.` });
  if (st.undoRate !== null && st.undoRate > 0) out.push({ tone: 'caution', text: `${pct(st.undoRate)} of merged PRs were undone afterwards: the cost of merging by silence, in the only currency that counts.` });
  return out;
}

const csvCell = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** Anonymous per-PR rows: no author, no title, no branch. */
export function recordsCsv(records) {
  const head = ['id', 'source', 'kind', 'created', 'validated', 'opened', 'settled', 'lines', 'fuse_ms', 'agent', 'team', 'undone'];
  const iso = (ms) => (ms === null ? '' : new Date(ms).toISOString());
  return toCsv([head, ...records.map((r) => [r.id, r.src, r.kind, iso(r.createdAt), iso(r.validatedAt), iso(r.openedAt), iso(r.settledAt), r.lines, r.fuseMs ?? '', r.agent, r.team ?? '', r.undone])]);
}

/** Aggregates only (weekly outcomes, populations, teams). Safe to paste into a deck. */
export function aggregatesCsv(s) {
  const rows = [['section', 'name', 'n', 'merged', 'rejected', 'expired', 'shamed', 'median_cycle_ms']];
  for (const w of s.weekly) rows.push(['week', new Date(w.week).toISOString().slice(0, 10), w.merged + w.rejected + w.expired + w.shamed, w.merged, w.rejected, w.expired, w.shamed, '']);
  const grp = (section, name, g) => rows.push(g.suppressed ? [section, name, `<${s.minGroup}`, '', '', '', '', ''] : [section, name, g.n, g.merged, g.rejected, g.expired, g.shamed, g.p50 ?? '']);
  grp('population', 'human', s.populations.human);
  grp('population', 'agent', s.populations.agent);
  for (const t of s.teams) grp('team', t.team, t);
  return toCsv(rows);
}

// ---------------------------------------------------------------- synthetic data, clearly labelled as such

/** Deterministic pseudo-random numbers so the demo never changes between loads. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SYNTHETIC records for the demo view. They illustrate the dashboard; they describe no real team. */
export function demoRecords(now = Date.now(), seed = 7) {
  const rand = rng(seed);
  const hours = (h) => h * 3600_000;
  const logn = (median, spread) => median * Math.exp((rand() + rand() + rand() - 1.5) * spread);
  const records = [];
  const teams = ['platform', 'payments', 'growth', 'mobile'];
  const adoption = now - 56 * DAY;

  // Ordinary PRs for the 12 weeks before snapgit: slow reviews, a long tail, some abandoned.
  for (let i = 0; i < 170; i++) {
    const createdAt = adoption - rand() * 84 * DAY;
    const merged = rand() > 0.12;
    const wait = logn(hours(30), 1.5);
    records.push({ id: `pr-${i}`, src: 'gh', kind: merged ? 'merged' : 'closed', createdAt, settledAt: createdAt + wait, validatedAt: null, openedAt: null, lines: 0, fuseMs: null, agent: rand() < 0.04, team: null, undone: false, baseline: true });
  }
  // snapgit PRs for the last 8 weeks.
  for (let i = 0; i < 260; i++) {
    const createdAt = adoption + rand() * 56 * DAY;
    const agent = rand() < 0.42;
    const team = teams[Math.floor(rand() * teams.length)];
    const lines = Math.max(1, Math.round(logn(60, 1.6)));
    const fuseMs = Math.min(3600_000, Math.max(15_000, (10 + 0.5 * lines) * 1000));
    const ciWait = logn(7 * 60_000, 0.8);
    const roll = rand();
    const failRate = agent ? 0.16 : 0.07;
    const expireRate = 0.09;
    const rejectRate = 0.08;
    const base = { id: `snap-${i}`, src: 'gh', createdAt, lines, fuseMs, agent, team, undone: false, baseline: false };
    if (roll < failRate) {
      records.push({ ...base, kind: 'shamed', validatedAt: null, openedAt: null, settledAt: createdAt + ciWait });
      continue;
    }
    const validatedAt = createdAt + ciWait;
    if (roll < failRate + expireRate) {
      records.push({ ...base, kind: 'expired', validatedAt, openedAt: null, settledAt: createdAt + 24 * 3600_000 });
      continue;
    }
    const openedAt = validatedAt + logn(hours(2.2), 1.2);
    if (roll < failRate + expireRate + rejectRate) {
      records.push({ ...base, kind: 'rejected', validatedAt, openedAt, settledAt: openedAt + rand() * fuseMs });
      continue;
    }
    records.push({ ...base, kind: 'merged', validatedAt, openedAt, settledAt: openedAt + fuseMs, undone: rand() < 0.02 });
  }
  return records.map((r) => ({ ...r, createdAt: Math.round(r.createdAt), settledAt: Math.round(r.settledAt), validatedAt: r.validatedAt === null ? null : Math.round(r.validatedAt), openedAt: r.openedAt === null ? null : Math.round(r.openedAt) }));
}
