import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snap, featureRepo, repo, T0, git, sh, BIN } from './helpers.js';

const J = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test('skill: prints the bundled skill and it names the real commands', () => {
  const dir = repo();
  const r = snap(dir, ['skill']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^---\nname: snapgit/);
  const help = snap(dir, ['help']).stdout;
  for (const cmd of r.stdout.match(/snapgit (snap|status|pr send|pr ls|pr burn|pr checks|undo|policy|shame|metrics|graveyard|resurrect)\b/g)) {
    assert.ok(help.includes(cmd.trim()) , `skill mentions "${cmd}" which is not in help`);
  }
});

test('init --agent writes the skill and an idempotent AGENTS.md block; --workflow never overwrites', () => {
  const dir = repo();
  const r = snap(dir, ['init', '--agent', '--workflow']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, '.claude/skills/snapgit/SKILL.md')));
  assert.ok(existsSync(join(dir, '.github/workflows/snapgit.yml')));
  const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(first, /snapgit skill/);
  const again = snap(dir, ['init', '--agent', '--workflow']);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), first);
  assert.match(again.stdout, /already exists/);
});

test('init --agent keeps existing AGENTS.md content', () => {
  const dir = repo();
  sh(dir, 'sh', ['-c', 'printf "# Mine\\nkeep me\\n" > AGENTS.md']);
  snap(dir, ['init', '--agent']);
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(text, /^# Mine\nkeep me\n/);
  assert.equal(text.match(/snapgit:begin/g).length, 1);
});

test('--json: ls, status, pr send, pr ls', () => {
  const dir = featureRepo();
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['snap', 'wip/x', '--ttl', '2h', '--stay']);
  const ls = J(snap(dir, ['ls', '--json']));
  assert.ok(ls.some((b) => b.name === 'wip/x' && b.msLeft > 0));
  git(dir, 'switch', '-q', 'feat');
  const sent = J(snap(dir, ['pr', 'send', '--json', '--ttl', '1h']));
  assert.equal(sent.ok, true);
  assert.match(sent.id, /^[0-9a-f]{8}$/);
  assert.equal(sent.head, 'feat');
  const list = J(snap(dir, ['pr', 'ls', '--json']));
  assert.equal(list.prs[0].id, sent.id);
  assert.equal(list.prs[0].opened, false);
  const st = J(snap(dir, ['status', '--json']));
  assert.equal(st.branch, 'feat');
  assert.equal(st.prs.length, 1);
  assert.equal(st.frozen, null);
  assert.match(snap(dir, ['status']).stdout, /1 live PR/);
});

test('pr send --json reports CI shame as ok:false with exit 1', () => {
  const dir = featureRepo();
  git(dir, 'switch', '-q', 'main');
  sh(dir, 'sh', ['-c', `printf '%s' '{"checks":[{"name":"tests","run":"echo boom >&2; exit 3"}]}' > snapgit.json`]);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'rules');
  git(dir, 'switch', '-q', 'feat'); git(dir, 'rebase', '-q', 'main');
  const r = snap(dir, ['pr', 'send', '--json']);
  assert.equal(r.status, 1);
  const o = JSON.parse(r.stdout);
  assert.equal(o.ok, false);
  assert.equal(o.shamed.check, 'tests');
  assert.equal(o.shamed.exitCode, 3);
});
