import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const auth = createRequire(import.meta.url)('../web/api/_auth.js');

const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sek' };
const req = (url, headers = {}) => ({ url, headers: { host: 'snap.example.com', 'x-forwarded-proto': 'https', ...headers } });
const res = () => { const r = { headers: {}, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b; } }; return r; };

test('status says whether sign-in is configured, never the secret', () => {
  const r = res(); auth.status(req('/api/auth/status'), r, ENV);
  assert.equal(r.body, '{"enabled":true,"installUrl":null}');
  const r3 = res(); auth.status(req('/api/auth/status'), r3, { ...ENV, GITHUB_APP_SLUG: 'snapgit-x' });
  assert.equal(JSON.parse(r3.body).installUrl, 'https://github.com/apps/snapgit-x/installations/new');
  const r2 = res(); auth.status(req('/api/auth/status'), r2, {});
  assert.equal(r2.body, '{"enabled":false,"installUrl":null}');
});

test('login redirects to GitHub with a fresh state, sets an HttpOnly cookie, and refuses an unconfigured host', () => {
  const r = res(); auth.login(req('/api/auth/login?return=/metrics'), r, ENV);
  assert.equal(r.statusCode, 302);
  const loc = new URL(r.headers.Location);
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://snap.example.com/api/auth/callback');
  assert.ok(!r.headers.Location.includes('sek'));
  assert.match(r.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Path=\/api\/auth; Max-Age=600; Secure/);
  assert.ok(r.headers['Set-Cookie'].includes(loc.searchParams.get('state')));
  const bad = res(); auth.login(req('/api/auth/login'), bad, {});
  assert.equal(bad.statusCode, 503);
});

test('return paths are a closed list (no open redirect)', () => {
  const r = res(); auth.login(req('/api/auth/login?return=//evil.example'), r, ENV);
  assert.match(r.headers['Set-Cookie'], /\|%2F;/);
});

async function run(query, cookieState, fetchImpl) {
  const login = res(); auth.login(req('/api/auth/login?return=/metrics'), login, ENV);
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const state = new URL(login.headers.Location).searchParams.get('state');
  const r = res();
  await auth.callback(req(`/api/auth/callback?${query(state)}`, { cookie: cookieState ?? cookie }), r, ENV, fetchImpl);
  return r;
}

test('callback exchanges the code with the secret and hands the token back in the fragment only', async () => {
  let call;
  const r = await run((s) => `code=abc&state=${s}`, undefined, async (url, init) => { call = { url, body: JSON.parse(init.body) }; return { json: async () => ({ access_token: 'ghu_tok', expires_in: 28800 }) }; });
  assert.equal(call.url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(call.body, { client_id: 'cid', client_secret: 'sek', code: 'abc', redirect_uri: 'https://snap.example.com/api/auth/callback' });
  assert.equal(r.headers.Location, 'https://snap.example.com/metrics#gh_token=ghu_tok&expires_in=28800');
  assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('callback rejects a wrong or missing state (CSRF), GitHub errors, and network failures, without a token', async () => {
  const never = async () => { throw new Error('must not call GitHub'); };
  let r = await run(() => 'code=abc&state=forged', undefined, never);
  assert.match(r.headers.Location, /#auth_error=/);
  r = await run((s) => `code=abc&state=${s}`, 'snapgit_oauth=', never);
  assert.match(r.headers.Location, /#auth_error=/);
  r = await run((s) => `error=access_denied&error_description=Nope&state=${s}`, undefined, never);
  assert.equal(r.headers.Location, 'https://snap.example.com/metrics#auth_error=Nope');
  r = await run((s) => `code=abc&state=${s}`, undefined, async () => ({ json: async () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) }));
  assert.match(decodeURIComponent(r.headers.Location), /incorrect or expired/);
  r = await run((s) => `code=abc&state=${s}`, undefined, async () => { throw new Error('offline'); });
  assert.match(decodeURIComponent(r.headers.Location), /could not reach GitHub/);
  assert.ok(![r].some((x) => x.headers.Location.includes('gh_token')));
});

test('rate limit: the 31st login from one address in a minute is refused, another address is not', () => {
  const from = (ip) => ({ url: '/api/auth/login', headers: { host: 'snap.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': ip } });
  let last;
  for (let i = 0; i < 31; i++) { last = res(); auth.login(from('203.0.113.9'), last, ENV); }
  assert.equal(last.statusCode, 429);
  assert.equal(last.headers['Retry-After'], '60');
  const other = res(); auth.login(from('203.0.113.10'), other, ENV);
  assert.equal(other.statusCode, 302);
});
