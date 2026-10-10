// Pure logic shared by the UI and the tests. No DOM, no network.

/** The fuse for PRs that predate size-proportional fuses. Newer PRs carry their own `fuseMs`. */
export const FUSE_MS = 60_000;
export const fuseOf = (record) => record.fuseMs ?? FUSE_MS;

/** "owner/repo", "github.com/owner/repo" or a full URL (with .git) -> { owner, repo } | null. */
export function parseRepo(input) {
  const m = String(input).trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const isPrId = (id) => /^[0-9a-f]{8}$/.test(String(id).trim().toLowerCase());

/** The moment the PR merges: its fuse after opening, or the branch deadline, whichever is first. */
export function mergesAt(record, receipt) {
  return Math.min(record.expiresAt, receipt ? receipt.openedAt + fuseOf(record) : Infinity);
}

export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/** Unified diff text -> [{ name, lines: [{ kind: 'add'|'del'|'ctx'|'hunk'|'meta', text }] }]. */
export function parseDiff(patch) {
  const files = [];
  let file = null;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = { name: text.split(' b/').pop(), lines: [] };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (text.startsWith('@@')) {
      file.inHunk = true;
      file.lines.push({ kind: 'hunk', text });
    } else if (/^(index |new file|deleted file|similarity|rename |old mode|new mode|--- |\+\+\+ |Binary files)/.test(text) && !file.inHunk) {
      file.lines.push({ kind: 'meta', text });
    } else if (text.startsWith('+')) {
      file.inHunk = true;
      file.lines.push({ kind: 'add', text });
    } else if (text.startsWith('-')) {
      file.inHunk = true;
      file.lines.push({ kind: 'del', text });
    } else if (text !== '') {
      file.inHunk = true;
      file.lines.push({ kind: 'ctx', text });
    }
  }
  for (const f of files) delete f.inHunk;
  return files;
}
