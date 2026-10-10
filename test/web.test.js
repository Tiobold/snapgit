import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, isPrId, mergesAt, clock, parseDiff, FUSE_MS } from '../web/lib/core.js';
import { DemoBackend, demoRecord } from '../web/lib/backends.js';

test('parseRepo accepts the usual spellings', () => {
  const want = { owner: 'Tiobold', repo: 'snapgit' };
  for (const s of ['Tiobold/snapgit', 'github.com/Tiobold/snapgit', 'https://github.com/Tiobold/snapgit', 'https://github.com/Tiobold/snapgit.git', ' Tiobold/snapgit/ ']) {
    assert.deepEqual(parseRepo(s), want, s);
  }
  assert.equal(parseRepo('nonsense'), null);
  assert.equal(parseRepo(''), null);
});

test('PR ids are exactly 8 hex characters', () => {
  assert.ok(isPrId('95962cb1'));
  for (const bad of ['', '95962cb', '95962cb1a', 'ZZZZZZZZ', '../../x']) assert.ok(!isPrId(bad), bad);
});

test('mergesAt matches the CLI: fuse after opening, or the branch deadline, whichever is first', () => {
  const record = { expiresAt: 1_000_000 };
  assert.equal(mergesAt(record, null), 1_000_000);
  assert.equal(mergesAt(record, { openedAt: 500_000 }), 500_000 + FUSE_MS);
  assert.equal(mergesAt(record, { openedAt: 990_000 }), 1_000_000);
  assert.equal(FUSE_MS, 60_000);
});

test('clock formats countdowns and never goes negative', () => {
  assert.equal(clock(60_000), '1:00');
  assert.equal(clock(59_001), '1:00');
  assert.equal(clock(9_000), '0:09');
  assert.equal(clock(-5), '0:00');
});

test('parseDiff splits files and classifies lines', () => {
  const files = parseDiff(demoRecord().patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'src/login.js');
  const kinds = files[0].lines.map((l) => l.kind);
  assert.deepEqual(kinds.filter((k) => k === 'add').length, 3);
  assert.deepEqual(kinds.filter((k) => k === 'del').length, 3);
  assert.ok(kinds.includes('hunk') && kinds.includes('meta') && kinds.includes('ctx'));
  // "---"/"+++" file headers are meta, but a removed line starting with "--" inside a hunk is a deletion
  const tricky = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- a comment\n+++ b comment\n');
  assert.deepEqual(tricky[0].lines.map((l) => l.kind), ['meta', 'meta', 'hunk', 'del', 'add']);
});

test('the demo backend only lets one opener and one rejection win', async () => {
  const b = new DemoBackend(demoRecord());
  assert.equal(await b.claim('d3adb33f', { opener: 'a' }), true);
  assert.equal(await b.claim('d3adb33f', { opener: 'b' }), false);
  assert.equal((await b.getReceipt()).opener, 'a');
  assert.equal(await b.reject('d3adb33f', { rejector: 'x' }), true);
  assert.equal(await b.reject('d3adb33f', { rejector: 'y' }), false);
  assert.equal(await b.getPr('nope'), null);
});
