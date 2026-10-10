const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/** "90s", "30m", "24h", "1d12h" -> milliseconds. */
export function parseDuration(text) {
  if (!/^(\d+[smhdw])+$/.test(text)) {
    throw new Error(`bad duration "${text}" (try 30m, 24h, 7d, 1d12h)`);
  }
  let ms = 0;
  for (const [, n, u] of text.matchAll(/(\d+)([smhdw])/g)) ms += Number(n) * UNITS[u];
  if (ms <= 0) throw new Error('duration must be greater than zero');
  return ms;
}

/** Milliseconds -> "2d 3h", "45m 10s", "12s". Top two non-zero units. */
export function formatDuration(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const parts = [];
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const n = Math.floor(s / size);
    s -= n * size;
    if (n > 0) parts.push(`${n}${label}`);
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

/** The clock. SNAPGIT_NOW (epoch ms) exists so tests and demos can time travel. */
export function now() {
  const fake = process.env.SNAPGIT_NOW;
  return fake ? Number(fake) : Date.now();
}
