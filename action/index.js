#!/usr/bin/env node
// Entry point of the snapgit GitHub Action. See action/README.md.
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from './github.js';
import { createEngine } from './engine.js';

const EVENTS = new Set(['pull_request', 'pull_request_target', 'pull_request_review', 'issue_comment']);
const input = (env, name, dflt = '') => env[`INPUT_${name.toUpperCase()}`] ?? dflt;

export async function runAction(env = process.env, { fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const gh = new GitHub({
    token: input(env, 'token') || env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    fetchImpl,
  });
  const now = () => (env.SNAPGIT_NOW ? Number(env.SNAPGIT_NOW) : Date.now());
  const engine = createEngine({
    gh, now, log: out,
    ignoreChecks: input(env, 'ignore-checks', 'snapgit').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const mode = input(env, 'mode', 'auto');
  const event = env.GITHUB_EVENT_NAME;
  let waitFor = null;

  if (mode === 'wait') {
    await waitLoop(engine, Number(input(env, 'pr')), {
      now, sleep, out,
      maxWaitMs: Number(input(env, 'max-wait', '21000')) * 1000,
      pollMs: Number(input(env, 'poll-seconds', '20')) * 1000,
    });
  } else if (mode === 'sweep' || !EVENTS.has(event)) {
    const settled = await engine.settleAll();
    const timers = await engine.sweepTimers();
    out(`settled ${Object.keys(settled).length} PR(s); deleted ${timers.length} expired branch(es)`);
  } else {
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    let r = {};
    if (event.startsWith('pull_request') && event !== 'pull_request_review') r = await engine.onPullRequest(payload.pull_request, payload.action, payload.label?.name);
    else if (event === 'pull_request_review') {
      if (payload.action === 'submitted') r = await engine.onReview(payload.pull_request.number, payload.review);
    } else if (event === 'issue_comment' && payload.issue?.pull_request && payload.action === 'created') {
      r = await engine.onComment(payload.issue.number, payload.comment);
    }
    waitFor = r.waitFor ?? null;
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `wait-pr=${waitFor?.number ?? ''}\nwait-until=${waitFor?.dueAt ?? ''}\n`);
  }
  return { waitFor };
}

/** Sleep until the PR's fuse burns out, settling it then. Exits early if it is rejected, merged or closed. */
export async function waitLoop(engine, n, { now, sleep, out, maxWaitMs, pollMs }) {
  const started = now();
  for (;;) {
    const result = await engine.settleOne(n);
    if (result === 'done' || result === 'none') { out(`PR #${n}: ${result === 'done' ? 'settled' : 'nothing to do'}`); return result; }
    if (now() - started > maxWaitMs) { out(`PR #${n}: still ${result} after ${Math.round(maxWaitMs / 1000)}s; the next scheduled sweep takes over`); return result; }
    const loaded = await engine.load(n);
    const untilDue = loaded ? engine.dueOf(loaded.state) - now() : pollMs;
    await sleep(Math.max(250, Math.min(pollMs, untilDue + 250)));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAction().catch((e) => {
    process.stderr.write(`snapgit: ${e.message}\n`);
    process.exitCode = 1;
  });
}
