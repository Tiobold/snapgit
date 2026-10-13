// Runs every test/*.test.js. Node 20's `node --test` does not expand globs (Node 21+ does), so list the files ourselves.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('test').filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
