import { git } from './git.js';
import { matchesAny } from './glob.js';

export const FUSE_DEFAULTS = Object.freeze({ baseSec: 10, secPerLine: 0.5, minSec: 15, maxSec: 3600 });

/**
 * The fuse is proportional to the size of the change: base + secPerLine * weightedLines, clamped to [min, max].
 * Files matching fuse.ignore (lockfiles, build output) count for nothing, and fuse.weights can make some
 * paths count for more or less (a migration is not a README). `files` is [{ path, lines }].
 * Returns { fuseMs, lines (counted), rawLines, ignoredLines, ignoredFiles }.
 */
export function fuseFromFiles(files, fuse = {}, overrides = {}) {
  const cfg = { ...FUSE_DEFAULTS, ...fuse, ...overrides };
  let counted = 0;
  let raw = 0;
  let ignoredLines = 0;
  const ignoredFiles = [];
  for (const f of files) {
    raw += f.lines;
    if (matchesAny(f.path, fuse.ignore)) {
      ignoredLines += f.lines;
      ignoredFiles.push(f.path);
      continue;
    }
    const w = (fuse.weights ?? []).find((x) => matchesAny(f.path, [x.glob]));
    counted += f.lines * (w ? w.multiplier : 1);
  }
  const lines = Math.round(counted);
  const sec = Math.min(cfg.maxSec, Math.max(cfg.minSec, cfg.baseSec + cfg.secPerLine * lines));
  return { fuseMs: Math.round(sec * 1000), lines, rawLines: raw, ignoredLines, ignoredFiles };
}

/** Per-file changed lines (added + deleted) between base and head. Binary files count as zero. */
export function gatherFiles(base, head, cwd) {
  const out = git(['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-renames', `${base}...${head}`], { cwd });
  return out.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...path] = l.split('\t');
    return { path: path.join('\t'), lines: (Number(a) || 0) + (Number(d) || 0) };
  });
}
