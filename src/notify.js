import { spawnSync } from 'node:child_process';
import { run } from './git.js';
import { now } from './time.js';

/**
 * Tell people what happened. Configure any of (git config):
 *   snapgit.notifyCommand  a shell command; gets the event as JSON on stdin and SNAPGIT_EVENT in its env
 *   snapgit.slackWebhook   a Slack incoming-webhook URL; gets the event as one line of text
 *   snapgit.shameCommand   legacy: same as notifyCommand, but only for "shamed"
 * Events: sent, opened, halfway, merged, rejected, shamed, expired, held, undone, frozen, thawed.
 * Notifying never throws; problems come back as a list of warnings.
 */
export function emit(event, payload, cwd) {
  const body = { event, at: now(), ...payload };
  const warnings = [];
  const cfg = (k) => { const r = run(['config', k], { cwd }); return r.ok ? r.out.trim() : ''; };
  const commands = [cfg('snapgit.notifyCommand'), event === 'shamed' ? cfg('snapgit.shameCommand') : ''].filter(Boolean);
  for (const cmd of commands) {
    const r = spawnSync(cmd, { shell: true, cwd, input: JSON.stringify(body), encoding: 'utf8', timeout: 30_000, env: { ...process.env, SNAPGIT_EVENT: event } });
    if (r.status !== 0) warnings.push(`notifyCommand failed (exit ${r.status ?? 'timeout'})`);
  }
  const slack = cfg('snapgit.slackWebhook');
  if (slack) {
    // Synchronous POST from a tiny child so the CLI stays synchronous.
    const script = 'const [u,t]=JSON.parse(require("fs").readFileSync(0,"utf8"));fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t}),signal:AbortSignal.timeout(15000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))';
    const r = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify([slack, body.text ?? event]), encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) warnings.push('slackWebhook failed');
  }
  return warnings;
}
