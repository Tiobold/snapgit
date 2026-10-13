// An in-memory GitHub, served over HTTP, implementing just the endpoints the snapgit Action uses.
// The real client and engine run against it, so the REST calls are exercised too.
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const shaOf = (text) => createHash('sha1').update(text).digest('hex');

export function createFakeGitHub({ repo = 'acme/app', defaultBranch = 'main' } = {}) {
  const [owner, name] = repo.split('/');
  const db = {
    repo: { full_name: repo, default_branch: defaultBranch },
    pulls: new Map(), // number -> pr
    files: new Map(), commits: new Map(), comments: new Map(), // by PR number
    contents: new Map(), // `${ref}:${path}` -> text
    checks: new Map(), // sha -> { runs: [], statuses: [] }
    branches: new Set([defaultBranch]),
    refs: new Map(), // "snapgit/timer/x" -> blob sha
    blobs: new Map(),
    labels: new Map(), // number -> Set
    merges: [], // calls to the merge endpoint
    reverts: [],
    mergeBehavior: null, // set to { status, message } to make the merge endpoint fail
    branchShas: new Map(), trees: new Map(), commitTrees: new Map(),
    nextComment: 1, nextPr: 1, calls: [],
  };

  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const api = {
    db,
    /** Open a PR as `author`. files: [{filename, additions, deletions}]. */
    addPull({ author = 'dev', title = 'Add thing', head = 'feat', base = defaultBranch, files = [{ filename: 'a.js', additions: 10, deletions: 0 }], commits, sha, draft = false, headRepo = repo } = {}) {
      const number = db.nextPr++;
      const pr = {
        number, node_id: `PR_${number}`, state: 'open', title, draft, merged: false,
        user: { login: author }, base: { ref: base }, head: { ref: head, sha: sha ?? `sha${number}`.padEnd(40, '0'), repo: { full_name: headRepo } },
      };
      db.pulls.set(number, pr);
      db.files.set(number, files);
      db.commits.set(number, commits ?? [{ author: { login: author }, commit: { message: 'work', author: { name: author, email: `${author}@example.com` } } }]);
      db.comments.set(number, []);
      db.labels.set(number, new Set());
      db.branches.add(head);
      return pr;
    },
    setFile(ref, path, text) { db.contents.set(`${ref}:${path}`, text); },
    setPolicy(policy, ref = defaultBranch) { api.setFile(ref, 'snapgit.json', typeof policy === 'string' ? policy : JSON.stringify(policy)); },
    setChecks(sha, { runs = [], statuses = [] }) { db.checks.set(sha, { runs, statuses }); },
    /** A human comment. author_association defaults to MEMBER, like a teammate. */
    comment(number, login, body, association = 'MEMBER') {
      const c = { id: db.nextComment++, body, user: { login, type: 'User' }, author_association: association };
      db.comments.get(number).push(c);
      return c;
    },
    addTimer(branch, expiresAt) {
      const sha = String(db.blobs.size + 1).padStart(40, '0');
      db.blobs.set(sha, JSON.stringify({ branch, expiresAt }));
      db.refs.set(`snapgit/timer/${branch}`, sha);
      db.branches.add(branch);
    },
    botComments: (n) => db.comments.get(n).filter((c) => c.user.type === 'Bot'),
    lastBotText: (n) => api.botComments(n).filter((c) => !c.body.startsWith('<!-- snapgit-state')).at(-1)?.body,
    state(n) {
      const c = db.comments.get(n).find((x) => x.body.startsWith('<!-- snapgit-state '));
      return c ? JSON.parse(c.body.slice('<!-- snapgit-state '.length, c.body.indexOf(' -->'))) : null;
    },
    statusLine: (n) => db.comments.get(n).find((x) => x.body.startsWith('<!-- snapgit-state '))?.body.split('\n').slice(1).join('\n'),
  };

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const page = (list, url) => {
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const p = Number(url.searchParams.get('page') ?? 1);
    return list.slice((p - 1) * per, p * per);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      db.calls.push(`${req.method} ${url.pathname}`);
      const send = (s, b) => json(res, s, b);
      const path = decodeURIComponent(url.pathname);

      if (path === '/graphql' && req.method === 'POST') {
        const pr = [...db.pulls.values()].find((p) => p.node_id === body.variables?.id);
        if (!pr?.merged) return send(200, { errors: [{ message: 'Pull request is not merged' }] });
        const number = db.nextPr++;
        db.reverts.push(pr.number);
        return send(200, { data: { revertPullRequest: { revertPullRequest: { number, url: `https://github.test/${repo}/pull/${number}` } } } });
      }
      const prefix = `/repos/${owner}/${name}`;
      if (!path.startsWith(prefix)) return send(404, { message: 'Not Found' });
      const rest = path.slice(prefix.length) || '/';
      let m;

      if (rest === '/' && req.method === 'GET') return send(200, db.repo);
      if (rest === '/pulls' && req.method === 'GET') return send(200, page([...db.pulls.values()].filter((p) => p.state === 'open'), url));
      if ((m = rest.match(/^\/pulls\/(\d+)$/))) {
        const pr = db.pulls.get(Number(m[1]));
        if (!pr) return send(404, { message: 'Not Found' });
        if (req.method === 'GET') return send(200, pr);
        if (req.method === 'PATCH') { Object.assign(pr, body.state ? { state: body.state } : {}); return send(200, pr); }
      }
      if ((m = rest.match(/^\/pulls\/(\d+)\/files$/))) return send(200, page(db.files.get(Number(m[1])) ?? [], url));
      if ((m = rest.match(/^\/pulls\/(\d+)\/commits$/))) return send(200, page(db.commits.get(Number(m[1])) ?? [], url));
      if ((m = rest.match(/^\/pulls\/(\d+)\/merge$/)) && req.method === 'PUT') {
        const pr = db.pulls.get(Number(m[1]));
        db.merges.push({ number: pr.number, ...body });
        if (db.mergeBehavior) return send(db.mergeBehavior.status, { message: db.mergeBehavior.message });
        if (body.sha && body.sha !== pr.head.sha) return send(409, { message: 'Head branch was modified. Review and try the merge again.' });
        pr.merged = true; pr.state = 'closed';
        return send(200, { merged: true, sha: `merge${pr.number}`.padEnd(40, 'f') });
      }
      if ((m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
        const list = db.comments.get(Number(m[1]));
        if (!list) return send(404, { message: 'Not Found' });
        if (req.method === 'GET') return send(200, page(list, url));
        const c = { id: db.nextComment++, body: body.body, user: bot };
        list.push(c);
        return send(201, c);
      }
      if ((m = rest.match(/^\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
        for (const list of db.comments.values()) { const c = list.find((x) => x.id === Number(m[1])); if (c) { c.body = body.body; return send(200, c); } }
        return send(404, { message: 'Not Found' });
      }
      if ((m = rest.match(/^\/issues\/(\d+)\/labels$/)) && req.method === 'POST') {
        for (const l of body.labels) db.labels.get(Number(m[1])).add(l);
        return send(200, [...db.labels.get(Number(m[1]))].map((n) => ({ name: n })));
      }
      if (rest.startsWith('/contents/') && req.method === 'GET') {
        const text = db.contents.get(`${url.searchParams.get('ref')}:${rest.slice('/contents/'.length)}`);
        return text === undefined ? send(404, { message: 'Not Found' }) : send(200, { encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: shaOf(text) });
      }
      if (rest.startsWith('/contents/') && req.method === 'PUT') {
        const key = `${body.branch}:${rest.slice('/contents/'.length)}`;
        if (!db.branches.has(body.branch)) return send(404, { message: 'Branch not found' });
        const existing = db.contents.get(key);
        if (existing !== undefined && body.sha !== shaOf(existing)) return send(409, { message: `${rest.slice(10)} does not match ${shaOf(existing)}` });
        if (existing === undefined && body.sha) return send(422, { message: 'sha was supplied but the file does not exist' });
        db.putCount = (db.putCount ?? 0) + 1;
        if (db.failAllPuts) return send(500, { message: 'metrics storage is down' });
        if (db.failNextPut) { db.failNextPut = false; db.contents.set(key, existing ?? '[]'); return send(409, { message: 'conflict (simulated race)' }); }
        db.contents.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
        return send(existing === undefined ? 201 : 200, { content: { sha: shaOf(db.contents.get(key)) } });
      }
      if (rest === '/git/blobs' && req.method === 'POST') {
        const sha = shaOf(body.content);
        db.blobs.set(sha, body.content);
        return send(201, { sha });
      }
      if (rest === '/git/trees' && req.method === 'POST') {
        const sha = shaOf(JSON.stringify(body.tree));
        db.trees.set(sha, body.tree);
        return send(201, { sha });
      }
      if (rest === '/git/commits' && req.method === 'POST') {
        const sha = shaOf(`${body.tree}${body.message}${db.commitTrees.size}`);
        db.commitTrees.set(sha, body.tree);
        return send(201, { sha });
      }
      if ((m = rest.match(/^\/commits\/([^/]+)\/check-runs$/))) return send(200, { check_runs: page(db.checks.get(m[1])?.runs ?? [], url) });
      if ((m = rest.match(/^\/commits\/([^/]+)\/status$/))) return send(200, { statuses: page(db.checks.get(m[1])?.statuses ?? [], url) });
      if ((m = rest.match(/^\/git\/matching-refs\/(.+)$/))) {
        return send(200, [...db.refs].filter(([r]) => r.startsWith(m[1])).map(([r, sha]) => ({ ref: `refs/${r}`, object: { sha } })));
      }
      if ((m = rest.match(/^\/git\/blobs\/(.+)$/))) {
        const b = db.blobs.get(m[1]);
        return b === undefined ? send(404, { message: 'Not Found' }) : send(200, { encoding: 'base64', content: Buffer.from(b).toString('base64') });
      }
      if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) return db.branches.has(m[1]) ? send(200, { ref: `refs/heads/${m[1]}`, object: { sha: db.branchShas.get(m[1]) ?? 'e'.repeat(40) } }) : send(404, { message: 'Not Found' });
      if (rest === '/git/refs' && req.method === 'POST') {
        const short = body.ref.replace(/^refs\//, '');
        if (short.startsWith('heads/')) {
          const branch = short.slice('heads/'.length);
          if (db.branches.has(branch)) return send(422, { message: 'Reference already exists' });
          db.branches.add(branch);
          for (const entry of db.trees.get(db.commitTrees.get(body.sha)) ?? []) db.contents.set(`${branch}:${entry.path}`, db.blobs.get(entry.sha));
          return send(201, { ref: body.ref });
        }
        db.refs.set(short, body.sha);
        return send(201, { ref: body.ref });
      }
      if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'DELETE') {
        return db.branches.delete(m[1]) ? send(204) : send(422, { message: 'Reference does not exist' });
      }
      if ((m = rest.match(/^\/git\/refs\/(snapgit\/.+)$/)) && req.method === 'DELETE') {
        return db.refs.delete(m[1]) ? send(204) : send(422, { message: 'Reference does not exist' });
      }
      return send(404, { message: `Not Found: ${req.method} ${rest}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      api.url = `http://127.0.0.1:${server.address().port}`;
      api.repo = repo;
      api.close = () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
      resolve(api);
    });
  });
}
