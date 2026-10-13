// GitHub App manifest flow: build the manifest, and turn the one-time code GitHub sends back into credentials.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
export function buildManifest({ origin, pagePath, name = 'snapgit', isPublic = false }) {
  return {
    name,
    url: origin,
    redirect_url: `${origin}${pagePath}`,
    callback_urls: [`${origin}/api/auth/callback`],
    public: !!isPublic,
    hook_attributes: { url: 'https://example.com/unused', active: false },
    request_oauth_on_install: false,
    default_permissions: { contents: 'write', pull_requests: 'read' },
    default_events: [],
  };
}

export function formAction({ org = '', state }) {
  const base = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export async function convertCode(code, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'That code was already used or has expired (they last one hour and work once). Start again.' : `GitHub said ${res.status}`);
  const d = await res.json();
  return { slug: d.slug, name: d.name, clientId: d.client_id, clientSecret: d.client_secret, htmlUrl: d.html_url };
}
