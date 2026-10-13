// Sign in with GitHub, without a database: a GitHub App's OAuth web flow, three tiny stateless endpoints.
// The client secret lives only in this function's environment; the browser gets a short-lived user token in a URL fragment.
// Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (a GitHub App's), optional PUBLIC_URL (e.g. https://snapgit.example.com).
const crypto = require('node:crypto');

const RETURNS = new Set(['/', '/metrics', '/metrics.html', '/index.html']);
const COOKIE = 'snapgit_oauth';

const enabled = (env = process.env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

function origin(req, env = process.env) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function send(res, status, headers = {}, body = '') {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers })) res.setHeader(k, v);
  res.end(body);
}
const json = (res, status, obj) => send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));

const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }))[COOKIE];
const setCookie = (value, maxAge, secure) => `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

function status(req, res, env = process.env) {
  json(res, 200, { enabled: enabled(env) });
}

function login(req, res, env = process.env) {
  if (!enabled(env)) return json(res, 503, { error: 'Sign in with GitHub is not configured on this host. Use a token instead.' });
  const url = new URL(req.url, 'http://x');
  const ret = RETURNS.has(url.searchParams.get('return')) ? url.searchParams.get('return') : '/';
  const state = crypto.randomBytes(24).toString('base64url');
  const o = origin(req, env);
  const auth = new URL('https://github.com/login/oauth/authorize');
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${o}/api/auth/callback`);
  auth.searchParams.set('state', state);
  send(res, 302, { Location: auth.toString(), 'Set-Cookie': setCookie(`${state}|${encodeURIComponent(ret)}`, 600, o.startsWith('https')) });
}

async function callback(req, res, env = process.env, fetchImpl = fetch) {
  const o = origin(req, env);
  const url = new URL(req.url, 'http://x');
  const [state, retEnc] = (cookieOf(req) || '').split('|');
  const ret = RETURNS.has(decodeURIComponent(retEnc || '')) ? decodeURIComponent(retEnc) : '/';
  const clear = setCookie('', 0, o.startsWith('https'));
  const back = (frag) => send(res, 302, { Location: `${o}${ret}#${frag}`, 'Set-Cookie': clear });
  if (!enabled(env)) return back('auth_error=' + encodeURIComponent('not configured'));
  if (url.searchParams.get('error')) return back('auth_error=' + encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error')));
  const code = url.searchParams.get('code');
  const given = url.searchParams.get('state');
  const ok = state && given && state.length === given.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(given));
  if (!code || !ok) return back('auth_error=' + encodeURIComponent('sign-in expired or was not started here; try again'));
  let data;
  try {
    const r = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${o}/api/auth/callback` }),
    });
    data = await r.json();
  } catch {
    return back('auth_error=' + encodeURIComponent('could not reach GitHub'));
  }
  if (!data.access_token) return back('auth_error=' + encodeURIComponent(data.error_description || data.error || 'GitHub did not return a token'));
  const q = new URLSearchParams({ gh_token: data.access_token });
  if (data.expires_in) q.set('expires_in', String(data.expires_in));
  back(q.toString());
}

module.exports = { enabled, status, login, callback, RETURNS };
