// Loading metrics from GitHub, from the browser. Two reads:
//   1. outcomes.json on the branch snapgit-metrics (written by the Action, or by `snapgit metrics --publish`)
//   2. recently closed pull requests, as the baseline of "what normal PRs cost"
import { normalizeOutcome, normalizePull } from './metrics.js';

const API = 'https://api.github.com';

async function get(path, token, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (res.status === 404) return null;
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub rate limit reached. Add a token (any token, no scopes needed for public repos) to raise it.');
  if (res.status === 401) throw new Error('GitHub rejected that token.');
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

/** { records, notes }. Missing metrics are a note, not an error: the dashboard can still show the baseline. */
export async function loadFromGitHub({ owner, repo, token = '', branch = 'snapgit-metrics', pages = 5, fetchImpl = fetch }) {
  const notes = [];
  const file = await get(`/repos/${owner}/${repo}/contents/outcomes.json?ref=${encodeURIComponent(branch)}`, token, fetchImpl);
  let outcomes = [];
  if (!file) {
    notes.push(`No outcomes.json on the "${branch}" branch yet. The snapgit Action writes it as PRs settle, or run snapgit metrics --publish.`);
  } else {
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob((file.content ?? '').replace(/\n/g, '')), (c) => c.charCodeAt(0)));
      outcomes = JSON.parse(text);
    } catch {
      notes.push('outcomes.json could not be read (is it valid JSON?).');
    }
  }
  const pulls = [];
  for (let page = 1; page <= pages; page++) {
    const chunk = await get(`/repos/${owner}/${repo}/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`, token, fetchImpl);
    if (chunk === null) throw new Error(`Repository ${owner}/${repo} was not found (or is private: add a token that can read it).`);
    pulls.push(...chunk);
    if (chunk.length < 100) break;
  }
  const records = [...outcomes.map(normalizeOutcome), ...pulls.map(normalizePull)].filter(Boolean);
  if (pulls.length >= pages * 100) notes.push(`Baseline uses the ${pulls.length} most recently updated closed PRs; older ones are not counted.`);
  return { records, notes };
}
