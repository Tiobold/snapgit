import { fuseOf, parseRepo, isPrId, mergesAt, clock, parseDiff } from './lib/core.js';
import { GitHubBackend, DemoBackend, demoRecord } from './lib/backends.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // never innerHTML: PR contents are untrusted
  return node;
};

const state = { backend: null, id: '', record: null, receipt: null, rejection: null, me: null, timer: null, poll: null };

function show(id, on) { $(id).hidden = !on; }
function fail(message) { const e = $('error'); e.textContent = message; e.hidden = !message; }

async function load(backend, id) {
  fail('');
  clearInterval(state.timer);
  clearInterval(state.poll);
  Object.assign(state, { backend, id, record: null, receipt: null, rejection: null, me: null });
  $('diff').dataset.id = '';
  try {
    state.record = await backend.getPr(id);
    if (!state.record) throw new Error(`PR ${id} is gone: it merged, was rejected, was withdrawn, or never existed.`);
    if (backend.token || backend.demo) state.me = await backend.whoami().catch(() => null);
    await refresh();
  } catch (e) {
    show('pr', false);
    return fail(e.message);
  }
  show('pr', true);
  $('pr-title').textContent = state.record.title;
  $('pr-meta').textContent = `${state.record.author} · ${state.record.head} → ${state.record.base} · ${backend.label}`;
  render();
  state.timer = setInterval(render, 250);
  state.poll = setInterval(() => refresh().then(render).catch(() => {}), 3000);
}

async function refresh() {
  const [receipt, rejection] = await Promise.all([state.backend.getReceipt(state.id), state.backend.getRejection(state.id)]);
  state.receipt = receipt;
  state.rejection = rejection;
}

const mine = () => state.receipt && state.me && state.receipt.opener === state.me;

function render() {
  const { record, receipt, rejection } = state;
  if (!record) return;
  const due = mergesAt(record, receipt);
  const left = due - Date.now();
  const rejectedInTime = rejection && rejection.rejectedAt <= due;
  const over = left <= 0;

  const fuseOn = !!receipt && !rejectedInTime;
  show('fuse', fuseOn);
  show('bar', fuseOn);
  if (fuseOn) {
    $('clock').textContent = clock(left);
    $('fuse').classList.toggle('hot', left < Math.min(15_000, fuseOf(record) / 4) && !over);
    $('bar-fill').style.width = `${Math.max(0, Math.min(100, (left / fuseOf(record)) * 100))}%`;
  }

  const canRead = mine() && !over && !rejectedInTime;
  show('locked', !receipt && !over && !rejectedInTime);
  show('diff', canRead);
  show('reject-form', !over && !rejectedInTime); // anyone can reject, even without opening it
  if (canRead && !$('diff').dataset.id) paintDiff(record);

  let status;
  if (rejectedInTime) status = `🚫 Rejected by ${rejection.rejector}${rejection.reason ? `: “${rejection.reason}”` : ''}. Nothing will merge.`;
  else if (over) status = state.backend.demo
    ? `🔀 The fuse burned out and nobody rejected it. In real life the sender's snapgit merges ${record.head} into ${record.base} now. (This was the demo sandbox, nothing was merged.)`
    : `🔀 Too late. Nobody rejected it, so the sender's snapgit merges ${record.head} into ${record.base} the next time it sweeps.`;
  else if (!receipt) status = 'Unopened. Nobody has lit the fuse yet.';
  else if (mine()) status = `🔥 The fuse is lit. Reject within ${clock(left)} or ${record.head} merges into ${record.base}.`;
  else status = `👀 ${receipt.opener} opened this and is reviewing it. It merges in ${clock(left)} unless rejected. You can still reject it.`;
  $('status').textContent = status;

  if (over || rejectedInTime) { clearInterval(state.timer); clearInterval(state.poll); show('diff', false); }
}

function paintDiff(record) {
  const box = $('diff');
  box.dataset.id = record.id;
  box.replaceChildren();
  if (record.message) box.append(el('div', 'ln meta', record.message));
  for (const f of parseDiff(record.patch)) {
    box.append(el('div', 'file', f.name));
    for (const l of f.lines) box.append(el('div', `ln ${l.kind}`, l.text));
  }
}

async function open() {
  fail('');
  try {
    const me = state.me ?? (await state.backend.whoami());
    state.me = me;
    const receipt = { id: state.id, title: state.record.title, sender: state.record.author, opener: me, openedAt: Date.now(), screenshot: false };
    if (!(await state.backend.claim(state.id, receipt))) {
      await refresh();
      if (!mine()) return render();
    } else {
      state.receipt = receipt;
    }
    render();
  } catch (e) {
    fail(e.message);
  }
}

async function reject(event) {
  event.preventDefault();
  fail('');
  try {
    const me = state.me ?? (await state.backend.whoami());
    state.me = me;
    const ok = await state.backend.reject(state.id, { id: state.id, rejector: me, rejectedAt: Date.now(), reason: $('reason').value.trim() });
    await refresh();
    if (!ok && !state.rejection) throw new Error('Could not record the rejection.');
    render();
  } catch (e) {
    fail(e.message);
  }
}

$('find').addEventListener('submit', (e) => {
  e.preventDefault();
  const repo = parseRepo($('repo').value);
  const id = $('pr-id').value.trim().toLowerCase();
  if (!repo) return fail('Enter the repository as owner/repo.');
  if (!isPrId(id)) return fail('A PR id is 8 hex characters, like 95962cb1.');
  load(new GitHubBackend({ ...repo, token: $('token').value.trim() }), id);
});
$('demo').addEventListener('click', () => {
  const record = demoRecord();
  load(new DemoBackend(record), record.id);
});
$('open').addEventListener('click', open);
$('reject-form').addEventListener('submit', reject);

const params = new URLSearchParams(location.search);
if (params.get('repo')) $('repo').value = params.get('repo');
if (params.get('pr')) $('pr-id').value = params.get('pr');
