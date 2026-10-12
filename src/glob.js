// A small gitignore-style glob matcher, shared by the CLI and the GitHub Action.
//   "package-lock.json"  matches at any depth        "migrations/**"  is anchored to the repo root
//   "*.lock"             any depth                    "dist/"          a directory at any depth
//   "**/*.generated.*"   any depth                    "?"              one character (not "/")
const cache = new Map();

export function globToRegExp(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
  cache.set(pattern, rx);
  return rx;
}

export const matchesAny = (path, patterns = []) => patterns.some((p) => globToRegExp(p).test(path));
