import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.js';

const MARK = '# snapgit-hook';
const HOOKS = ['post-commit', 'post-checkout', 'post-merge'];
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/snapgit.js');
const fwd = (p) => p.replace(/\\/g, '/'); // Git for Windows runs hooks with sh, which wants forward slashes
const LINE = `${MARK}\n"${fwd(process.execPath)}" "${fwd(BIN)}" sweep --quiet --offline || true\n`;

/** Install hooks so expired branches vanish without anyone having to remember. */
export function installHooks(cwd) {
  const dir = resolve(cwd, git(['rev-parse', '--git-path', 'hooks'], { cwd }));
  mkdirSync(dir, { recursive: true });
  const installed = [];
  for (const name of HOOKS) {
    const file = resolve(dir, name);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (existing?.includes(MARK)) continue;
    writeFileSync(file, existing ? `${existing.trimEnd()}\n${LINE}` : `#!/bin/sh\n${LINE}`);
    chmodSync(file, 0o755);
    installed.push(name);
  }
  return installed;
}
