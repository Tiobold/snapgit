import { summarize, insights, fmtDuration, pct, filterRecords, demoRecords, aggregatesCsv, recordsCsv, KINDS, DAY } from './lib/metrics.js';
import { loadFromGitHub } from './lib/metrics-data.js';
import { initSignIn, installHint } from './lib/auth.js';
import { parseRepo } from './lib/core.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const state = { records: [], demo: false, summary: null, scoped: [] };

// ---- tiny DOM helpers. Everything user-derived goes in through textContent, never innerHTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---- tooltip: enhances, never gates. Every value is also in a label, the legend or the table twin.
const tip = $('tip');
function showTip(el, { value, title, lines = [] }, evt) {
  tip.replaceChildren(h('span', { class: 'v' }, value), h('span', { class: 't' }, title), ...lines.map((l) => h('div', { class: 't' }, l)));
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const x = evt?.clientX ?? r.left + r.width / 2;
  const y = evt?.clientY ?? r.top;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 12))}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
}
const hideTip = () => { tip.hidden = true; };
function mark(el, label, tipData) {
  el.setAttribute('class', `${el.getAttribute('class') ?? ''} m`.trim());
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.addEventListener('pointermove', (e) => showTip(el, tipData, e));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => showTip(el, tipData));
  el.addEventListener('blur', hideTip);
  return el;
}

// ---- shared chart pieces
const W = 760;
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((c) => c >= v) ?? 10 * p;
};
/** A bar whose data end (right) is rounded 4px and whose baseline end is square. */
const barRight = (x, y, w, hgt, r = 4) => {
  const rr = Math.min(r, w, hgt / 2);
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${hgt - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`;
};
/** Same, for a column whose data end is the top. */
const barTop = (x, y, w, hgt, r = 4) => {
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}v-${hgt - rr}a${rr},${rr} 0 0 1 ${rr},-${rr}h${w - 2 * rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${hgt - rr}z`;
};
const fits = (text, px) => String(text).length * 6.6 + 12 <= px; // only label inside a mark when it fits

function legend(items) {
  return h('ul', { class: 'legend' }, items.map(([cls, text]) => h('li', {}, h('span', { class: `key ${cls}` }), text)));
}

/** A chart card: title, caption, the figure, and its table twin behind a toggle. */
function card(host, { title, caption, figure, legendEl, table }) {
  const tableWrap = h('div', { hidden: true }, table);
  const toggle = h('button', { class: 'btn twin', type: 'button', 'aria-pressed': 'false' }, 'Table view');
  const figureWrap = h('div', {}, figure, legendEl);
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? 'Chart view' : 'Table view';
    tableWrap.hidden = !on;
    figureWrap.hidden = on;
  });
  host.replaceChildren(h('div', { class: 'chart-head' }, h('div', {}, h('h2', {}, title), h('p', { class: 'cap' }, caption)), toggle), figureWrap, tableWrap);
}

function dataTable(caption, head, rows, numeric = []) {
  return h('table', { class: 'data' }, h('caption', {}, caption),
    h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { class: numeric.includes(i) ? 'n' : null, scope: 'col' }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'n' : null }, c))))));
}

// ---- chart 1: where the time goes (one stacked ordinal bar vs the baseline, same axis)
function stagesChart(sum) {
  const b = sum.breakdown;
  const base = sum.baseline;
  const total = [b.ci, b.reviewer, b.fuse].reduce((a, v) => a + (v ?? 0), 0);
  const host = $('chart-stages');
  if (!b.n && base.p50 === null) { host.replaceChildren(h('h2', {}, 'Where the time goes'), h('p', { class: 'cap' }, 'Nothing merged in this window yet.')); return; }
  const left = 190;
  const plot = W - left - 70;
  const max = niceMax(Math.max(total, base.p50 ?? 0) * 1.02);
  const x = (v) => left + (v / max) * plot;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} 150`, role: 'group', 'aria-label': 'Where the time goes' });
  for (let i = 0; i <= 4; i++) {
    const gx = left + (plot * i) / 4;
    svg.append(s('line', { class: 'grid', x1: gx, x2: gx, y1: 18, y2: 110 }), s('text', { class: 'muted', x: gx, y: 128, 'text-anchor': 'middle' }, fmtDuration((max * i) / 4)));
  }
  svg.append(s('line', { class: 'axis', x1: left, x2: left, y1: 18, y2: 110 }));

  const stages = [['CI', b.ci, 'f-st1', 'k-st1'], ['Waiting for a reviewer', b.reviewer, 'f-st2', 'k-st2'], ['Fuse', b.fuse, 'f-st3', 'k-st3']];
  if (b.n) {
    const y = 28;
    svg.append(s('text', { class: 'strong', x: left - 10, y: y + 17, 'text-anchor': 'end' }, 'snapgit'), s('text', { class: 'muted', x: left - 10, y: y + 32, 'text-anchor': 'end' }, `${b.n} merged PRs, median`));
    let cursor = 0;
    stages.forEach(([name, v, cls], i) => {
      if (!v) return;
      const x0 = x(cursor);
      const w = Math.max(2, x(cursor + v) - x0);
      const last = i === stages.length - 1 || stages.slice(i + 1).every(([, nv]) => !nv);
      const seg = last ? s('path', { class: `${cls} gap`, d: barRight(x0, y, w, 24) }) : s('rect', { class: `${cls} gap`, x: x0, y, width: w, height: 24 });
      svg.append(mark(seg, `${name}: ${fmtDuration(v)}`, { value: fmtDuration(v), title: `${name} (median)`, lines: [`${pct(v / total)} of the median time to merge`] }));
      if (fits(fmtDuration(v), w)) svg.append(s('text', { x: x0 + w / 2, y: y + 16, 'text-anchor': 'middle', fill: i === 0 ? '#0b0b0b' : '#ffffff', class: 'strong' }, fmtDuration(v)));
      cursor += v;
    });
    svg.append(s('text', { class: 'strong', x: x(cursor) + 8, y: y + 17 }, fmtDuration(total)));
  } else {
    svg.append(s('text', { class: 'muted', x: left + 8, y: 45 }, 'No merged PRs with recorded stages yet'));
  }
  if (base.p50 !== null) {
    const y = 68;
    const w = Math.max(2, x(base.p50) - left);
    svg.append(s('text', { class: 'strong', x: left - 10, y: y + 17, 'text-anchor': 'end' }, base.label.replace(/^PRs /, '')), s('text', { class: 'muted', x: left - 10, y: y + 32, 'text-anchor': 'end' }, `${base.merged} merged PRs, median`));
    svg.append(mark(s('path', { class: 'f-base', d: barRight(left, y, w, 24) }), `${base.label}: ${fmtDuration(base.p50)}`, { value: fmtDuration(base.p50), title: `${base.label}, median time to merge`, lines: [`${base.merged} merged, ${base.abandoned} closed without merging`] }));
    svg.append(s('text', { class: 'strong', x: left + w + 8, y: y + 17 }, fmtDuration(base.p50)));
  }
  const rows = [];
  if (b.n) rows.push(['snapgit', 'Median time to merge', fmtDuration(total)], ...stages.map(([n, v]) => ['snapgit', `  ${n}`, fmtDuration(v)]));
  if (base.p50 !== null) rows.push([base.label, 'Median time to merge', fmtDuration(base.p50)]);
  card(host, {
    title: 'Where the time goes',
    caption: `Median stages of a merged PR, against ${base.p50 !== null ? base.label : 'ordinary PRs (no baseline in this window)'}. Same axis, so the bars compare directly.`,
    figure: svg,
    legendEl: legend([['k-st1', 'CI'], ['k-st2', 'Waiting for a reviewer'], ['k-st3', 'Fuse'], ['k-base', 'Ordinary PRs (no stages recorded)']]),
    table: dataTable('Median time to merge by stage', ['Group', 'Stage', 'Duration'], rows),
  });
}

// ---- chart 2: p50 / p75 / p90, snapgit vs baseline
function percentileChart(sum) {
  const host = $('chart-percentiles');
  const st = sum.stats;
  const base = sum.baseline;
  const rows = [['Median', st.p50, base.p50], ['75th percentile', st.p75, base.p75], ['90th percentile', st.p90, base.p90]];
  if (rows.every((r) => r[1] === null)) { host.replaceChildren(h('h2', {}, 'Time to merge: typical and worst cases'), h('p', { class: 'cap' }, 'Nothing merged in this window yet.')); return; }
  const left = 150;
  const plot = W - left - 80;
  const max = niceMax(Math.max(...rows.flatMap((r) => [r[1] ?? 0, r[2] ?? 0])) * 1.02);
  const x = (v) => left + (v / max) * plot;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} 205`, role: 'group', 'aria-label': 'Time to merge percentiles' });
  for (let i = 0; i <= 4; i++) {
    const gx = left + (plot * i) / 4;
    svg.append(s('line', { class: 'grid', x1: gx, x2: gx, y1: 10, y2: 170 }), s('text', { class: 'muted', x: gx, y: 190, 'text-anchor': 'middle' }, fmtDuration((max * i) / 4)));
  }
  svg.append(s('line', { class: 'axis', x1: left, x2: left, y1: 10, y2: 170 }));
  rows.forEach(([name, a, b2], i) => {
    const y = 18 + i * 52;
    svg.append(s('text', { class: 'strong', x: left - 10, y: y + 24, 'text-anchor': 'end' }, name));
    for (const [j, [v, cls, who]] of [[a, 'f-s1', 'snapgit'], [b2, 'f-base', base.label]].entries()) {
      if (v === null) continue;
      const by = y + j * 22;
      const w = Math.max(2, x(v) - left);
      svg.append(mark(s('path', { class: cls, d: barRight(left, by, w, 18) }), `${name}, ${who}: ${fmtDuration(v)}`, { value: fmtDuration(v), title: `${name}, ${who}` }));
      svg.append(s('text', { class: 'strong', x: left + w + 8, y: by + 13 }, fmtDuration(v)));
    }
  });
  card(host, {
    title: 'Time to merge: typical and worst cases',
    caption: 'The 90th percentile is the PR somebody waited the longest for. Merged PRs only.',
    figure: svg,
    legendEl: legend([['k-s1', 'snapgit'], ['k-base', base.p50 !== null ? base.label : 'Ordinary PRs (no baseline)']]),
    table: dataTable('Time to merge percentiles', ['Percentile', 'snapgit', base.label], rows.map(([n, a, b2]) => [n, fmtDuration(a), fmtDuration(b2)]), [1, 2]),
  });
}

// ---- chart 3: outcomes by week (stacked columns, four categorical slots)
function weeklyChart(sum) {
  const host = $('chart-weekly');
  const weeks = sum.weekly.slice(-26);
  const total = (w) => KINDS.reduce((n, k) => n + w[k], 0);
  if (!weeks.length || weeks.every((w) => total(w) === 0)) { host.replaceChildren(h('h2', {}, 'Outcomes by week'), h('p', { class: 'cap' }, 'No settled PRs in this window yet.')); return; }
  const names = { merged: 'Merged', rejected: 'Rejected', expired: 'Expired unopened', shamed: 'Failed CI' };
  const cls = { merged: 'f-s1', rejected: 'f-s2', expired: 'f-s3', shamed: 'f-s4' };
  const left = 40;
  const right = 130;
  const top = 12;
  const bottom = 34;
  const H = 230;
  const plotW = W - left - right;
  const max = niceMax(Math.max(...weeks.map(total)));
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const band = plotW / weeks.length;
  const bw = Math.min(24, band * 0.7);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Outcomes by week' });
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(s('line', { class: 'grid', x1: left, x2: left + plotW, y1: y(v), y2: y(v) }), s('text', { class: 'muted', x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, Number.isInteger(v) ? v : v.toFixed(1)));
  }
  svg.append(s('line', { class: 'axis', x1: left, x2: left + plotW, y1: y(0), y2: y(0) }));
  weeks.forEach((w, i) => {
    const cx = left + band * i + (band - bw) / 2;
    let acc = 0;
    const live = KINDS.filter((k) => w[k] > 0);
    live.forEach((k, idx) => {
      const y0 = y(acc + w[k]);
      const hgt = y(acc) - y0;
      const top2 = idx === live.length - 1;
      svg.append(top2 ? s('path', { class: `${cls[k]} gap`, d: barTop(cx, y0, bw, Math.max(hgt, 1)) }) : s('rect', { class: `${cls[k]} gap`, x: cx, y: y0, width: bw, height: Math.max(hgt, 1) }));
      acc += w[k];
    });
    const label = new Date(w.week).toISOString().slice(5, 10);
    if (weeks.length <= 14 || i % 2 === 0) svg.append(s('text', { class: 'muted', x: cx + bw / 2, y: H - 14, 'text-anchor': 'middle' }, label));
    const hit = s('rect', { x: left + band * i, y: top, width: band, height: H - top - bottom, fill: 'transparent' });
    svg.append(mark(hit, `Week of ${label}: ${KINDS.map((k) => `${w[k]} ${names[k].toLowerCase()}`).join(', ')}`, {
      value: `${total(w)} PRs`, title: `Week of ${new Date(w.week).toISOString().slice(0, 10)}`, lines: KINDS.map((k) => `${names[k]}: ${w[k]}`),
    }));
  });
  // Direct labels on the last column's segments (selective: only where they fit and don't collide)
  const last = weeks[weeks.length - 1];
  let acc = 0;
  let prevY = Infinity;
  for (const k of KINDS) {
    if (!last[k]) continue;
    const mid = y(acc + last[k] / 2);
    acc += last[k];
    if (y(acc - last[k]) - y(acc) >= 14 && prevY - mid >= 14) {
      svg.append(s('text', { class: 'strong', x: left + plotW + 8, y: mid + 4 }, names[k]));
      prevY = mid;
    }
  }
  card(host, {
    title: 'Outcomes by week',
    caption: `How each PR ended, by the week it settled${sum.weekly.length > 26 ? ' (last 26 weeks)' : ''}. A growing "expired unopened" slice means review is not keeping up.`,
    figure: svg,
    legendEl: legend(KINDS.map((k) => [`k-${cls[k].slice(2)}`, names[k]])),
    table: dataTable('PRs by week and outcome', ['Week of', 'Merged', 'Rejected', 'Expired unopened', 'Failed CI'], weeks.map((w) => [new Date(w.week).toISOString().slice(0, 10), ...KINDS.map((k) => w[k])]), [1, 2, 3, 4]),
  });
}

// ---- tables (small groups are suppressed, with a visible reason)
function groupRow(name, g, min) {
  if (g.suppressed) return [name, h('span', { class: 'hidden' }, `fewer than ${min} PRs: hidden so no one can be singled out`), '', '', '', '', ''];
  return [name, g.n, pct(g.mergeRate), pct(g.expiredRate), pct(g.shameRate), g.rejectRate === null ? 'n/a' : pct(g.rejectRate), fmtDuration(g.p50)];
}
const GROUP_HEAD = ['Group', 'PRs', 'Merged', 'Expired unopened', 'Failed CI', 'Rejected (of opened)', 'Median time to merge'];
function populationTable(sum) {
  $('table-population').replaceChildren(
    h('h2', {}, 'Agent-authored vs human-authored'),
    h('p', { class: 'cap' }, 'Agent-authored means a commit names an AI agent as author or co-author. This compares kinds of authorship, not people.'),
    dataTable('PRs by author kind', GROUP_HEAD, [groupRow('Human', sum.populations.human, sum.minGroup), groupRow('Agent', sum.populations.agent, sum.minGroup)], [1, 2, 3, 4, 5, 6]),
  );
}
function teamTable(sum) {
  const host = $('table-teams');
  if (!sum.teams.length) {
    host.replaceChildren(h('h2', {}, 'By team'), h('p', { class: 'cap' }, 'No teams are defined. Add a "teams" map to snapgit.json (team name to a list of people) and outcomes are grouped by team from then on.'));
    return;
  }
  host.replaceChildren(
    h('h2', {}, 'By team'),
    h('p', { class: 'cap' }, `Teams come from snapgit.json. ${sum.untaggedN ? `${sum.untaggedN} PRs are not in any team and are only in the totals.` : ''}`),
    dataTable('PRs by team', GROUP_HEAD, sum.teams.map((t) => groupRow(t.team, t, sum.minGroup)), [1, 2, 3, 4, 5, 6]),
  );
}

// ---- hero, tiles, insights
function heroAndTiles(sum) {
  const st = sum.stats;
  $('hero-value').textContent = fmtDuration(st.p50);
  const d = $('hero-delta');
  d.className = 'hero-delta';
  if (sum.delta.p50 !== null) {
    const faster = sum.delta.p50 < 0;
    d.textContent = `${Math.abs(Math.round(sum.delta.p50 * 100))}% ${faster ? 'faster' : 'slower'} than ${sum.baseline.label} (median ${fmtDuration(sum.baseline.p50)})`;
    if (faster) d.classList.add('good');
  } else {
    d.textContent = st.p50 === null ? 'Nothing has merged in this window.' : 'No baseline of ordinary PRs in this window.';
  }
  const tile = (l, v, dd) => h('div', { class: 'tile' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), h('div', { class: 'd' }, dd));
  $('tiles').replaceChildren(
    tile('Settled PRs', String(sum.total), `${st.merged} merged`),
    tile('Merged', pct(st.mergeRate), 'of settled'),
    tile('Expired unopened', pct(st.expiredRate), 'nobody looked'),
    tile('Failed CI', pct(st.shameRate), 'before review'),
    tile('Undone', pct(st.undoRate), 'of merged'),
  );
  $('insights').replaceChildren(...insights(sum).map((i) => h('li', { class: i.tone }, i.text)));
}

// ---- wiring
function currentFilters() {
  const days = Number(document.querySelector('input[name="range"]:checked').value);
  const until = Date.now();
  return { since: until - days * DAY, until, population: $('population').value, team: $('team').value || null, baselineMode: $('baseline').value };
}

function render() {
  if (!state.records.length) { $('board').hidden = true; $('empty').hidden = false; return; }
  const f = currentFilters();
  const sum = summarize(state.records, f);
  state.summary = sum;
  state.scoped = filterRecords(state.records.filter((r) => !r.baseline), f);
  $('empty').hidden = true;
  $('board').hidden = false;
  heroAndTiles(sum);
  stagesChart(sum);
  percentileChart(sum);
  weeklyChart(sum);
  populationTable(sum);
  teamTable(sum);
  $('board').classList.remove('loading');
}

function setRecords(records, { demo = false, notes = [] } = {}) {
  state.records = records;
  state.demo = demo;
  $('demo-banner').hidden = !demo;
  $('notes').hidden = !notes.length;
  $('notes').textContent = notes.join(' ');
  const teams = [...new Set(records.filter((r) => !r.baseline && r.team).map((r) => r.team))].sort();
  const sel = $('team');
  const keep = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'All teams'), ...teams.map((t) => h('option', { value: t }, t)));
  sel.value = teams.includes(keep) ? keep : '';
  render();
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

$('filters').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;
  const repo = parseRepo($('repo').value);
  if (!repo) { $('error').textContent = 'Enter the repository as owner/repo.'; $('error').hidden = false; return; }
  $('board').classList.add('loading');
  try {
    const { records, notes } = await loadFromGitHub({ ...repo, token: $('token').value.trim() });
    setRecords(records, { notes });
    if (!records.length) { $('error').textContent = 'Nothing to show: no outcomes and no closed PRs were found.'; $('error').hidden = false; }
  } catch (err) {
    $('board').classList.remove('loading');
    $('error').textContent = err.message + (/not found/.test(err.message) ? installHint($('token').value.trim()) : '');
    $('error').hidden = false;
  }
});
$('demo').addEventListener('click', () => { $('error').hidden = true; setRecords(demoRecords(Date.now()), { demo: true }); });
for (const el of ['population', 'team', 'baseline']) $(el).addEventListener('change', render);
for (const r of document.querySelectorAll('input[name="range"]')) r.addEventListener('change', render);
$('csv-agg').addEventListener('click', () => state.summary && download('snapgit-aggregates.csv', aggregatesCsv(state.summary)));
$('csv-rec').addEventListener('click', () => download('snapgit-prs.csv', recordsCsv(state.scoped)));

const params = new URLSearchParams(location.search);
if (params.get('repo')) $('repo').value = params.get('repo');
if (params.get('demo') !== null) $('demo').click();
initSignIn({ button: $('signin'), tokenInput: $('token'), onError: (m) => { $('error').textContent = m; $('error').hidden = false; }, returnPath: '/metrics' });
