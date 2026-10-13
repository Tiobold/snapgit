// Sign in with GitHub (only shown when the host has it configured) and pick the token up from the URL fragment.
// Pages without the server piece (GitHub Pages, plain static hosts) simply never show the button.
export function takeTokenFromHash(hash, replace = (u) => history.replaceState(null, '', u)) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const token = p.get('gh_token');
  const error = p.get('auth_error');
  if (!token && !error) return null;
  replace(location.pathname + location.search);
  return { token, error, expiresIn: Number(p.get('expires_in')) || null };
}

let installUrl = null;
/** When a PR or repo "is not found" and the person signed in with GitHub, the likely cause is that the App is not installed there. */
export function installHint(token) {
  if (!String(token || '').startsWith('ghu_')) return '';
  return ` You signed in with GitHub: the snapgit App has to be installed on this repository (and its owner may need to approve it). Install it here: ${installUrl || 'https://github.com/settings/installations'}`;
}

export async function initSignIn({ button, tokenInput, onError, returnPath, fetchImpl = fetch }) {
  const got = takeTokenFromHash(location.hash);
  if (got?.token) { tokenInput.value = got.token; tokenInput.dispatchEvent(new Event('input', { bubbles: true })); }
  if (got?.error) onError?.(`GitHub sign-in did not finish: ${got.error}`);
  try {
    const res = await fetchImpl('api/auth/status', { headers: { Accept: 'application/json' } });
    const st = res.ok ? await res.json() : null;
    if (st?.enabled) {
      installUrl = st.installUrl || null;
      button.href = `api/auth/login?return=${encodeURIComponent(returnPath)}`;
      button.hidden = false;
    }
  } catch { /* no server piece here: the token field is the way in */ }
  return got;
}
