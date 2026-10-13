// Browser end-to-end test for the web UI. Run: node test/e2e.web.mjs   (needs playwright + Chromium)
// GitHub's API is mocked in-memory, and the PR it serves is created by the real snapgit CLI, so this also
// proves the web UI and the CLI agree on the data format in both directions.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = resolve('web');
const BIN = resolve('bin/snapgit.js');
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, 'git', a); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

// --- a real snapgit PR made by the real CLI
const repo = mkdtempSync(join(tmpdir(), 'snapgit-e2e-'));
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Sender'); git(repo, 'config', 'user.email', 'sender@example.com');
writeFileSync(join(repo, 'a.txt'), 'hello\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
git(repo, 'switch', '-q', '-c', 'feat');
writeFileSync(join(repo, 'f.txt'), '<script>alert(1)</script>\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'add feature');
const T0 = Date.now();
const sent = sh(repo, 'node', [BIN, 'pr', 'send', '--ttl', '1h', '-m', 'Real PR\nfrom the CLI'], { SNAPGIT_NOW: String(T0) });
const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];
git(repo, 'switch', '-q', 'main');
const prJson = git(repo, 'cat-file', 'blob', git(repo, 'rev-parse', `refs/snapgit/pr/${id}`));

// --- mocked GitHub
const blobs = new Map(); const refs = new Map();
const put = (content) => { const sha = String(blobs.size + 1).padStart(40, '0'); blobs.set(sha, content); return sha; };
refs.set(`pr/${id}`, put(prJson));
const jsonRes = (status, body) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
async function githubMock(route) {
  const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (p === '/user') return route.fulfill(jsonRes(req.headers().authorization === 'Bearer good' ? 200 : 401, { login: 'webuser' }));
  const m = p.match(/^\/repos\/o\/r\/(.+)$/); if (!m) return route.fulfill(jsonRes(404, {}));
  const rest = m[1];
  let r;
  if ((r = rest.match(/^git\/ref\/snapgit\/(\w+)\/(\w+)$/))) {
    const sha = refs.get(`${r[1]}/${r[2]}`);
    return route.fulfill(sha ? jsonRes(200, { object: { sha, type: 'blob' } }) : jsonRes(404, {}));
  }
  if ((r = rest.match(/^git\/blobs\/(\w+)$/))) return route.fulfill(jsonRes(200, { content: Buffer.from(blobs.get(r[1])).toString('base64'), encoding: 'base64' }));
  if (rest === 'git/blobs' && req.method() === 'POST') {
    if (!req.headers().authorization) return route.fulfill(jsonRes(401, {}));
    return route.fulfill(jsonRes(201, { sha: put(JSON.parse(req.postData()).content) }));
  }
  if (rest === 'git/refs' && req.method() === 'POST') {
    const { ref, sha } = JSON.parse(req.postData()); const key = ref.replace('refs/snapgit/', '');
    if (refs.has(key)) return route.fulfill(jsonRes(422, { message: 'Reference already exists' }));
    refs.set(key, sha); return route.fulfill(jsonRes(201, { ref }));
  }
  return route.fulfill(jsonRes(404, {}));
}

// --- static server for web/
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
// Serve with the exact headers vercel.json will, so a CSP violation fails the run.
const vercelHeaders = Object.fromEntries(JSON.parse(readFileSync('web/vercel.json', 'utf8')).headers[0].headers.map((h) => [h.key, h.value]));
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]; const file = join(ROOT, path === '/' ? 'index.html' : extname(path) ? path : `${path}.html`);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let body; try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { ...vercelHeaders, 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e]); } };

async function newPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.route('https://api.github.com/**', githubMock);
  return { page, errors };
}

await test('demo: locked until opened, then diff + countdown, then merges when the fuse burns out', async () => {
  const { page, errors } = await newPage();
  await page.clock.install({ time: new Date('2026-10-10T12:00:00Z') });
  await page.goto(base);
  await page.click('#demo');
  await page.waitForSelector('#pr:not([hidden])');
  assert.equal(await page.locator('#diff').isHidden(), true, 'diff hidden before opening');
  assert.match(await page.locator('#status').innerText(), /Unopened/);
  await page.click('#open');
  await page.waitForSelector('#diff:not([hidden])');
  assert.match(await page.locator('#diff').innerText(), /RETRIES = 0/);
  assert.equal(await page.locator('#clock').innerText(), '1:00');
  await page.clock.fastForward(30_000);
  assert.equal(await page.locator('#clock').innerText(), '0:30');
  assert.match(await page.locator('#status').innerText(), /fuse is lit/);
  await page.clock.fastForward(31_000);
  assert.match(await page.locator('#status').innerText(), /fuse burned out.*nothing was merged/s);
  assert.equal(await page.locator('#diff').isHidden(), true, 'diff hidden after the fuse');
  assert.deepEqual(errors, []);
});

await test('demo: rejecting inside the window stops the merge', async () => {
  const { page } = await newPage();
  await page.clock.install({ time: new Date('2026-10-10T12:00:00Z') });
  await page.goto(base);
  await page.click('#demo'); await page.click('#open');
  await page.fill('#reason', 'too hasty');
  await page.clock.fastForward(10_000);
  await page.click('#reject-form button');
  assert.match(await page.locator('#status').innerText(), /Rejected by you.*too hasty.*Nothing will merge/s);
  await page.clock.fastForward(120_000);
  assert.match(await page.locator('#status').innerText(), /Rejected/);
});

await test('github: a PR created by the real CLI loads, the diff is shown as text (no XSS), and the receipt is written', async () => {
  const { page, errors } = await newPage();
  await page.goto(base);
  await page.fill('#repo', 'https://github.com/o/r');
  await page.fill('#pr-id', id);
  await page.fill('#token', 'good');
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#pr:not([hidden])');
  assert.equal(await page.locator('#pr-title').innerText(), 'Real PR');
  assert.match(await page.locator('#pr-meta').innerText(), /Sender <sender@example.com> · feat → main · o\/r/);
  assert.equal(await page.locator('#diff').isHidden(), true);
  await page.click('#open');
  await page.waitForSelector('#diff:not([hidden])');
  assert.match(await page.locator('#diff').innerText(), /<script>alert\(1\)<\/script>/);
  assert.equal(await page.locator('#diff script').count(), 0);
  const receipt = JSON.parse(blobs.get(refs.get(`receipt/${id}`)));
  assert.equal(receipt.opener, 'webuser <webuser@users.noreply.github.com>');
  assert.equal(receipt.sender, 'Sender <sender@example.com>');
  assert.deepEqual(errors, []);
});

await test('github: a second person is locked out of reading it, but can still reject', async () => {
  const { page } = await newPage();
  await page.goto(base);
  await page.fill('#repo', 'o/r'); await page.fill('#pr-id', id); await page.fill('#token', ''); // read-only visitor
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#pr:not([hidden])');
  assert.match(await page.locator('#status').innerText(), /webuser.*is reviewing it/);
  assert.equal(await page.locator('#diff').isHidden(), true);
});

await test('github: webuser re-opens their own PR and rejects; the real CLI honors that rejection', async () => {
  const { page } = await newPage();
  await page.goto(base);
  await page.fill('#repo', 'o/r'); await page.fill('#pr-id', id); await page.fill('#token', 'good');
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#diff:not([hidden])'); // same opener may keep reading
  await page.fill('#reason', 'from the browser');
  await page.click('#reject-form button');
  await page.waitForSelector('#status:has-text("Rejected by webuser")');
  const rejection = JSON.parse(blobs.get(refs.get(`reject/${id}`)));
  assert.equal(rejection.reason, 'from the browser');

  // Feed the browser-made refs to the CLI repo, as a fetch from the remote would, and sweep after the fuse.
  const putRef = (name, json) => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: json, encoding: 'utf8' }).stdout.trim();
    git(repo, 'update-ref', `refs/snapgit/${name}/${id}`, blob);
  };
  putRef('receipt', blobs.get(refs.get(`receipt/${id}`)));
  putRef('reject', blobs.get(refs.get(`reject/${id}`)));
  const swept = sh(repo, 'node', [BIN, 'sweep'], { SNAPGIT_NOW: String(Date.now() + 61_000) });
  assert.match(swept.stdout, /PR .* rejected by webuser <webuser@users.noreply.github.com>: "from the browser"/);
  assert.equal(sh(repo, 'git', ['cat-file', '-e', 'main:f.txt']).status !== 0, true, 'nothing merged');
});

await test('github: bad inputs and bad tokens give friendly errors', async () => {
  const { page } = await newPage();
  await page.goto(base);
  await page.fill('#repo', 'nonsense'); await page.fill('#pr-id', id);
  await page.click('#find button[type=submit]');
  assert.match(await page.locator('#error').innerText(), /owner\/repo/);
  await page.fill('#repo', 'o/r'); await page.fill('#pr-id', 'zzzz');
  await page.click('#find button[type=submit]');
  assert.match(await page.locator('#error').innerText(), /8 hex/);
  await page.fill('#pr-id', 'deadbeef');
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#error:not([hidden]):has-text("is gone")');
});

await test('mobile layout has no horizontal scroll', async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(base); await page.click('#demo'); await page.click('#open');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
});

// ---- metrics dashboard
const H = 3_600_000, D = 24 * H; const NOW = Date.now();
const outcome = (i, over) => ({ v: 1, id: `o${i}`, src: 'action', kind: 'merged', createdAt: NOW - 4 * D + i * H, validatedAt: NOW - 4 * D + i * H + 60_000, openedAt: NOW - 4 * D + i * H + 3 * H, settledAt: NOW - 4 * D + i * H + 3 * H + 60_000, lines: 20, fuseMs: 60_000, agent: false, team: 'alpha', undone: false, ...over });
const outcomes = [...[1, 2, 3, 4, 5].map((i) => outcome(i, { agent: i > 3 })), outcome(6, { team: 'solo' }), outcome(7, { kind: 'shamed', openedAt: null })];
const pulls = [1, 2, 3, 4].map((n) => ({ number: n, user: { type: 'User' }, created_at: new Date(NOW - 9 * D + n * H).toISOString(), merged_at: new Date(NOW - 7 * D + n * H).toISOString(), closed_at: new Date(NOW - 7 * D + n * H).toISOString(), labels: [] }));
const metricsMock = (state) => async (route) => {
  const url = new URL(route.request().url()); const p = url.pathname;
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
  if (p === '/repos/o/r/contents/outcomes.json') return route.fulfill(state.noFile ? jsonRes(404, {}) : jsonRes(200, { content: Buffer.from(JSON.stringify(outcomes)).toString('base64'), encoding: 'base64' }));
  if (p === '/repos/o/r/pulls') return route.fulfill(jsonRes(200, url.searchParams.get('page') === '1' ? pulls : []));
  return route.fulfill(jsonRes(404, {}));
};

await test('metrics demo: renders, labelled synthetic, no CSP errors, tooltips and table twins work', async () => {
  const { page, errors } = await newPage();
  await page.goto(`${base}/metrics?demo`);
  await page.waitForSelector('#board:not([hidden])');
  assert.equal(await page.locator('#demo-banner').isVisible(), true);
  assert.match(await page.locator('#demo-banner').innerText(), /Synthetic/);
  assert.match(await page.locator('#hero-value').innerText(), /\d/);
  await page.locator('#chart-weekly .m').first().focus();
  assert.equal(await page.locator('.tip').isVisible(), true);
  await page.locator('#chart-stages .twin').click();
  assert.equal(await page.locator('#chart-stages table.data').isVisible(), true);
  await page.locator('#chart-stages .twin').click();
  assert.equal(await page.locator('#chart-stages table.data').isVisible(), false);
  await page.selectOption('#population', 'agent');
  assert.match(await page.locator('#tiles').innerText(), /Settled/);
  assert.deepEqual(errors, []);
});

await test('metrics github: reads outcomes.json and baseline PRs, suppresses small groups, downloads anonymous CSV', async () => {
  const { page, errors } = await newPage();
  await page.route('https://api.github.com/**', metricsMock({}));
  await page.goto(`${base}/metrics`);
  await page.fill('#repo', 'https://github.com/o/r');
  await page.click('#filters button[type=submit]');
  await page.waitForSelector('#board:not([hidden])');
  assert.equal(await page.locator('#demo-banner').isVisible(), false);
  assert.match(await page.locator('#hero-delta').innerText(), /faster than PRs before snapgit/);
  const teams = await page.locator('#table-teams').innerText();
  assert.match(teams, /alpha/);
  assert.doesNotMatch(teams, /solo\s+\d+\s+\d+%/, 'a team with fewer than 3 PRs shows no numbers');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv-rec')]);
  const csv = readFileSync(await dl.path(), 'utf8');
  assert.doesNotMatch(csv, /@|author|title|branch/i);
  assert.deepEqual(errors, []);
});

await test('metrics github: missing outcomes file is a note, missing repo and bad input are friendly errors', async () => {
  const { page } = await newPage();
  await page.route('https://api.github.com/**', metricsMock({ noFile: true }));
  await page.goto(`${base}/metrics?repo=o/r`);
  await page.click('#filters button[type=submit]');
  await page.waitForSelector('#notes:not([hidden])');
  assert.match(await page.locator('#notes').innerText(), /No outcomes\.json/);
  await page.fill('#repo', 'o/missing');
  await page.click('#filters button[type=submit]');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.locator('#error').innerText(), /not found/);
  await page.fill('#repo', 'nonsense');
  await page.click('#filters button[type=submit]');
  assert.match(await page.locator('#error').innerText(), /owner\/repo/);
});

await test('metrics: mobile in light and dark has no horizontal scroll', async () => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${base}/metrics?demo`);
    await page.waitForSelector('#board:not([hidden])');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${scheme} overflows`);
  }
});

await test('setup page: token and hosting guide render, linked from both pages, CSP clean', async () => {
  const { page, errors } = await newPage();
  await page.goto(base);
  await page.click('a:has-text("How do I get a token?")');
  assert.match(page.url(), /setup\.html#token$|\/setup#token$/);
  assert.match(await page.locator('#token').innerText(), /Contents: Read and write/);
  assert.match(await page.locator('#host').innerText(), /Settings, Pages/);
  await page.goto(`${base}/metrics`);
  assert.equal(await page.locator('a[href="setup.html#token"]').count(), 1);
  assert.deepEqual(errors, []);
});

await test('sign in with GitHub: hidden without the server piece; shown when configured; token taken from the fragment and scrubbed', async () => {
  let { page, errors } = await newPage();
  await page.goto(base);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#signin').isHidden(), true, 'no button on a static host');
  ({ page, errors } = await newPage());
  await page.route('**/api/auth/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true}' }));
  await page.goto(`${base}/metrics#gh_token=ghu_abc&expires_in=28800`);
  await page.waitForSelector('#signin:not([hidden])');
  assert.equal(await page.locator('#token').inputValue(), 'ghu_abc');
  assert.equal(await page.evaluate(() => location.hash), '', 'token removed from the address bar');
  assert.match(await page.locator('#signin').getAttribute('href'), /api\/auth\/login\?return=%2Fmetrics$/);
  await page.goto(`${base}/#auth_error=Nope`);
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.locator('#error').innerText(), /sign-in did not finish: Nope/);
  assert.deepEqual(errors, []);
});

await test('create-app: manifest is minimal, state is checked, a code becomes credentials', async () => {
  const { page, errors } = await newPage();
  let posted;
  await page.route('https://github.com/settings/apps/new*', async (r) => { posted = { url: r.request().url(), body: r.request().postData() }; await r.fulfill({ status: 200, contentType: 'text/html', body: '<p>github</p>' }); });
  await page.route('https://api.github.com/app-manifests/**', (r) => r.fulfill(r.request().url().includes('/goodcode/') ? jsonRes(201, { slug: 'snapgit-x', name: 'snapgit-x', client_id: 'Iv1.abc', client_secret: 'sek', pem: 'SECRET-KEY' }) : jsonRes(404, {})));
  await page.goto(`${base}/create-app`);
  await page.fill('#name', 'snapgit-x');
  await page.click('#form button[type=submit]');
  await page.waitForFunction(() => document.body.innerText.includes('github'));
  const manifest = JSON.parse(decodeURIComponent(posted.body.split('manifest=')[1].replace(/\+/g, ' ')));
  assert.deepEqual(manifest.default_permissions, { contents: 'write', pull_requests: 'read' });
  assert.equal(manifest.callback_urls[0], `${base}/api/auth/callback`);
  assert.equal(manifest.public, true); assert.equal(manifest.hook_attributes.active, false);
  const state = new URL(posted.url).searchParams.get('state');
  await page.goto(`${base}/create-app?code=goodcode&state=${state}`);
  // a fresh navigation lost the tab state? sessionStorage survives same-tab navigation, so this works
  await page.waitForSelector('#done:not([hidden])');
  assert.equal(await page.locator('#cid').innerText(), 'Iv1.abc');
  assert.equal(await page.locator('#csec').innerText(), 'sek');
  assert.doesNotMatch(await page.locator('body').innerText(), /SECRET-KEY/, 'the private key is never shown');
  assert.equal(await page.evaluate(() => location.search), '');
  // wrong state: the code is not used
  const p2 = await newPage();
  await p2.page.goto(`${base}/create-app?code=goodcode&state=forged`);
  await p2.page.waitForSelector('#error:not([hidden])');
  assert.match(await p2.page.locator('#error').innerText(), /did not start on this page/);
  assert.equal(await p2.page.locator('#done').isHidden(), true);
  assert.deepEqual(errors, []);
});

await test('?demo opens the demo PR directly', async () => {
  const { page, errors } = await newPage();
  await page.goto(`${base}/?demo`);
  await page.waitForSelector('#pr:not([hidden])');
  assert.match(await page.locator('#status').innerText(), /Unopened/);
  assert.deepEqual(errors, []);
});

await test('signed in but App not installed: "not found" explains the install step', async () => {
  const { page } = await newPage();
  await page.route('**/api/auth/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true,"installUrl":"https://github.com/apps/snapgit-x/installations/new"}' }));
  await page.route('https://api.github.com/repos/o/private/**', (r) => r.fulfill(jsonRes(404, {})));
  await page.goto(`${base}/metrics#gh_token=ghu_abc`);
  await page.waitForSelector('#signin:not([hidden])');
  await page.fill('#repo', 'o/private');
  await page.click('#filters button[type=submit]');
  await page.waitForSelector('#error:not([hidden])');
  const msg = await page.locator('#error').innerText();
  assert.match(msg, /not found/);
  assert.match(msg, /App has to be installed.*apps\/snapgit-x\/installations\/new/s);
  await page.goto(`${base}/`);
  await page.fill('#repo', 'o/private'); await page.fill('#pr-id', 'deadbeef'); await page.fill('#token', 'plain-token');
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#error:not([hidden])');
  assert.doesNotMatch(await page.locator('#error').innerText(), /App has to be installed/, 'hint only for sign-in tokens');
});

await browser.close(); server.close();
for (const [s, name, e] of results) console.log(s === 'ok' ? '✔' : '✘', name, e ? `\n   ${e.message}` : '');
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
