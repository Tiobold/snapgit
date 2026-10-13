// A small GitHub REST client for the snapgit Action. No dependencies: Node 20's fetch is enough.
export class GitHubError extends Error {
  constructor(status, message, body) {
    super(`GitHub ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

const seg = (path) => path.split('/').map(encodeURIComponent).join('/');
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export class GitHub {
  constructor({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
    this.token = token;
    this.repo = repo; // "owner/name"
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async #req(method, path, body) {
    const url = path.startsWith('http') ? path : `${this.apiUrl}/repos/${this.repo}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) throw new GitHubError(res.status, data?.message ?? res.statusText, data);
    return data;
  }

  async #paged(path) {
    const all = [];
    for (let page = 1; page < 50; page++) {
      const chunk = await this.#req('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...chunk);
      if (chunk.length < 100) break;
    }
    return all;
  }

  getRepo() { return this.#req('GET', ''); }
  getPull(n) { return this.#req('GET', `/pulls/${n}`); }
  listOpenPulls() { return this.#paged('/pulls?state=open'); }
  listFiles(n) { return this.#paged(`/pulls/${n}/files`); }
  listCommits(n) { return this.#paged(`/pulls/${n}/commits`); }
  listComments(n) { return this.#paged(`/issues/${n}/comments`); }
  createComment(n, body) { return this.#req('POST', `/issues/${n}/comments`, { body }); }
  updateComment(id, body) { return this.#req('PATCH', `/issues/comments/${id}`, { body }); }
  closePull(n) { return this.#req('PATCH', `/pulls/${n}`, { state: 'closed' }); }
  addLabel(n, label) { return this.#req('POST', `/issues/${n}/labels`, { labels: [label] }); }
  /** `sha` makes GitHub itself refuse the merge if the head moved since it was reviewed. */
  mergePull(n, { method = 'merge', title, sha } = {}) {
    return this.#req('PUT', `/pulls/${n}/merge`, { merge_method: method, ...(title ? { commit_title: title } : {}), ...(sha ? { sha } : {}) });
  }

  /** A file with its blob sha (needed to update it safely), or null. */
  async getFileMeta(path, ref) {
    try {
      const f = await this.#req('GET', `/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`);
      return { text: Buffer.from(f.content ?? '', 'base64').toString('utf8'), sha: f.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  /** Create or update a file. With `sha` GitHub rejects the write (409) if someone else changed the file first. */
  putFile(path, { message, text, branch, sha }) {
    return this.#req('PUT', `/contents/${seg(path)}`, { message, content: Buffer.from(text, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) });
  }
  /** A new branch holding one file and no history (an orphan), made with the git data API. */
  async createOrphanBranch(branch, path, text, message) {
    const blob = await this.#req('POST', '/git/blobs', { content: text, encoding: 'utf-8' });
    const tree = await this.#req('POST', '/git/trees', { tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await this.#req('POST', '/git/commits', { message, tree: tree.sha, parents: [] });
    return this.#req('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  /** Tip of a branch, or null. */
  async branchSha(name) {
    try { return (await this.#req('GET', `/git/ref/heads/${seg(name)}`)).object.sha; } catch (e) { if (e.status === 404) return null; throw e; }
  }
  createRef(ref, sha) { return this.#req('POST', '/git/refs', { ref: `refs/${ref}`, sha }); }

  /** File contents at a ref, or null if it does not exist. */
  async getFile(path, ref) {
    try {
      const f = await this.#req('GET', `/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(f.content ?? '', f.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async deleteRef(ref) { // ref like "heads/foo" or "snapgit/timer/foo"
    try { await this.#req('DELETE', `/git/refs/${seg(ref)}`); return true; } catch (e) { if (e.status === 404 || e.status === 422) return false; throw e; }
  }
  async branchExists(name) {
    try { await this.#req('GET', `/git/ref/heads/${seg(name)}`); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  listMatchingRefs(prefix) { return this.#req('GET', `/git/matching-refs/${prefix}`); }
  async readBlobJson(sha) {
    const b = await this.#req('GET', `/git/blobs/${sha}`);
    try { return JSON.parse(Buffer.from(b.content, 'base64').toString('utf8')); } catch { return null; }
  }

  /**
   * Combined CI state of a commit from check runs and commit statuses.
   * Checks whose name starts with one of `ignore` (snapgit's own jobs) are not counted, or it would wait on itself.
   * Returns { state: 'success' | 'failure' | 'pending' | 'none', failing: [{ name, output }] }.
   */
  async checkStatus(sha, ignore = []) {
    const runs = [];
    for (let page = 1; page < 30; page++) {
      const chunk = (await this.#req('GET', `/commits/${sha}/check-runs?per_page=100&page=${page}`))?.check_runs ?? [];
      runs.push(...chunk);
      if (chunk.length < 100) break;
    }
    const statuses = [];
    for (let page = 1; page < 30; page++) {
      const chunk = (await this.#req('GET', `/commits/${sha}/status?per_page=100&page=${page}`))?.statuses ?? [];
      statuses.push(...chunk);
      if (chunk.length < 100) break;
    }
    const combined = { statuses };
    const skip = (name) => ignore.some((p) => String(name).toLowerCase().startsWith(p.toLowerCase()));
    const failing = [];
    let pending = false;
    let any = false;
    for (const r of runs) {
      if (skip(r.name)) continue;
      any = true;
      if (r.status !== 'completed') pending = true;
      else if (FAILED.has(r.conclusion)) failing.push({ name: r.name, output: r.output?.summary || r.output?.title || r.conclusion });
    }
    for (const s of combined?.statuses ?? []) {
      if (skip(s.context)) continue;
      any = true;
      if (s.state === 'pending') pending = true;
      else if (s.state === 'failure' || s.state === 'error') failing.push({ name: s.context, output: s.description || s.state });
    }
    return { state: failing.length ? 'failure' : pending ? 'pending' : any ? 'success' : 'none', failing };
  }

  /** GitHub's own "revert" for a merged PR: opens a revert PR (it never force-pushes). Returns { number, url }. */
  async revertPull(nodeId) {
    const root = this.apiUrl.replace(/\/api\/v3$/, '');
    const url = this.apiUrl === 'https://api.github.com' ? 'https://api.github.com/graphql' : `${root}/graphql`;
    const q = 'mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number url } } }';
    const res = await this.#req('POST', url, { query: q, variables: { id: nodeId } });
    if (res.errors?.length) throw new GitHubError(422, res.errors[0].message, res);
    return res.data.revertPullRequest.revertPullRequest;
  }
}
