import { buildManifest, formAction, convertCode } from './lib/app-manifest.js';

const $ = (id) => document.getElementById(id);
const fail = (m) => { $('error').textContent = m; $('error').hidden = !m; };
const KEY = 'snapgit-app-state';
const pagePath = location.pathname;
$('cb').textContent = `${location.origin}/api/auth/callback`;

function prepare() {
  const state = crypto.randomUUID();
  try { sessionStorage.setItem(KEY, state); } catch { /* the check below then refuses, with a message */ }
  $('manifest').value = JSON.stringify(buildManifest({ origin: location.origin, pagePath, name: $('name').value.trim() || 'snapgit', isPublic: $('public').checked }));
  $('form').action = formAction({ org: $('org').value.trim(), state });
}
$('form').addEventListener('submit', prepare);

const q = new URLSearchParams(location.search);
if (q.get('code')) {
  let saved = null;
  try { saved = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  history.replaceState(null, '', pagePath);
  if (!saved || saved !== q.get('state')) {
    fail('This sign-up did not start on this page (or the tab was reset), so I will not use the code. Start again below.');
  } else {
    try {
      const app = await convertCode(q.get('code'));
      $('cid').textContent = app.clientId;
      $('csec').textContent = app.clientSecret;
      $('install').href = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
      $('start').hidden = true;
      $('done').hidden = false;
    } catch (e) { fail(e.message); }
  }
}
prepare(); // after the code check, which reads the state prepare() would overwrite
