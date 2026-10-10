// Two interchangeable backends. Both expose the same operations over the same data model the
// snapgit CLI uses: refs/snapgit/pr/<id>, /receipt/<id> and /reject/<id>, each pointing at a JSON blob.

const API = 'https://api.github.com';

export class GitHubBackend {
  constructor({ owner, repo, token }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token || '';
    this.label = `${owner}/${repo}`;
    this.demo = false;
  }

  async #call(path, init = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    return res;
  }

  async #readRef(name, id) {
    const res = await this.#call(`git/ref/snapgit/${name}/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub said ${res.status} while reading ${name}/${id}`);
    const { object } = await res.json();
    const blob = await this.#call(`git/blobs/${object.sha}`);
    if (!blob.ok) throw new Error(`GitHub said ${blob.status} while reading the ${name} blob`);
    const { content } = await blob.json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0))));
  }

  /** Create a ref only if it does not exist yet. Returns false if someone else got there first. */
  async #createRef(name, id, data) {
    const blob = await this.#call('git/blobs', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(data), encoding: 'utf-8' }) });
    if (blob.status === 401 || blob.status === 403 || blob.status === 404) throw new Error('This needs a GitHub token with write access to the repository.');
    if (!blob.ok) throw new Error(`GitHub said ${blob.status} while writing`);
    const { sha } = await blob.json();
    const ref = await this.#call('git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/snapgit/${name}/${id}`, sha }) });
    if (ref.status === 422) return false;
    if (!ref.ok) throw new Error(`GitHub said ${ref.status} while creating ${name}/${id}`);
    return true;
  }

  async whoami() {
    if (!this.token) throw new Error('Paste a GitHub token first: opening and rejecting write to the repository.');
    const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('That token was not accepted by GitHub.');
    const { login } = await res.json();
    return `${login} <${login}@users.noreply.github.com>`;
  }

  getPr = (id) => this.#readRef('pr', id);
  getReceipt = (id) => this.#readRef('receipt', id);
  getRejection = (id) => this.#readRef('reject', id);
  claim = (id, receipt) => this.#createRef('receipt', id, receipt);
  reject = (id, rejection) => this.#createRef('reject', id, rejection);
}

/** In-memory sandbox so people can try the whole flow without a repository or a token. */
export class DemoBackend {
  constructor(record) {
    this.demo = true;
    this.label = 'demo sandbox';
    this.pr = record;
    this.receipt = null;
    this.rejection = null;
  }

  whoami = async () => 'you <you@demo.snapgit>';
  getPr = async (id) => (id === this.pr.id ? structuredClone(this.pr) : null);
  getReceipt = async () => (this.receipt ? structuredClone(this.receipt) : null);
  getRejection = async () => (this.rejection ? structuredClone(this.rejection) : null);
  claim = async (id, receipt) => (this.receipt ? false : ((this.receipt = receipt), true));
  reject = async (id, rejection) => (this.rejection ? false : ((this.rejection = rejection), true));
}

export function demoRecord(now = Date.now()) {
  return {
    v: 2,
    id: 'd3adb33f',
    title: 'Rewrite the login button in a hurry',
    message: 'Shipping before standup. Please do not look too closely.',
    author: 'Claudio <claudio@example.com>',
    base: 'main',
    head: 'wip/login-button',
    remote: 'origin',
    createdAt: now,
    expiresAt: now + 24 * 3600_000,
    commits: ['a1b2c3d make the button bigger', '9f8e7d6 add the ghost emoji'],
    stat: ' src/login.js | 6 +++---\n 1 file changed, 3 insertions(+), 3 deletions(-)',
    patch: `diff --git a/src/login.js b/src/login.js
index 1111111..2222222 100644
--- a/src/login.js
+++ b/src/login.js
@@ -1,7 +1,7 @@
 export function LoginButton({ onClick }) {
-  return <button onClick={onClick}>Log in</button>;
+  return <button className="big" onClick={onClick}>👻 Log in</button>;
 }

-export const TIMEOUT_MS = 30000;
-export const RETRIES = 3;
+export const TIMEOUT_MS = 60000;
+export const RETRIES = 0; // it works on my machine
 export default LoginButton;
`,
  };
}
