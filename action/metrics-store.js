// Outcomes live in one file, outcomes.json, on the branch snapgit-metrics (an orphan branch with no history).
// The dashboard reads it with a single request. Writes use GitHub's own optimistic concurrency (the file sha), and
// retry, so two jobs finishing at once cannot lose each other's outcome.
const FILE = 'outcomes.json';
const CAP = 2000;

async function update(gh, branch, change, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const meta = await gh.getFileMeta(FILE, branch);
    let list = [];
    if (meta) { try { list = JSON.parse(meta.text); } catch { list = []; } }
    const next = change(Array.isArray(list) ? list : []);
    if (next === null) return 'unchanged';
    const text = JSON.stringify(next.slice(-CAP));
    try {
      if (meta) { await gh.putFile(FILE, { message, text, branch, sha: meta.sha }); return 'updated'; }
      try { await gh.createOrphanBranch(branch, FILE, text, message); return 'created'; } catch (e) {
        if (e.status !== 422) throw e;
        await gh.putFile(FILE, { message, text, branch }); // the branch already exists without the file
        return 'created';
      }
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue; // someone else wrote first: read again, retry
      throw e;
    }
  }
  throw new Error('could not update the metrics file after several attempts');
}

/** Add (or refresh) one outcome, keyed by id. */
export function appendOutcome(gh, branch, outcome) {
  return update(gh, branch, (list) => {
    const i = list.findIndex((o) => o.id === outcome.id);
    if (i >= 0) list[i] = { ...list[i], ...outcome }; else list.push(outcome);
    return list;
  }, `snapgit metrics: ${outcome.kind} ${outcome.id}`);
}

/** Change fields of an existing outcome (for example undone: true). A missing outcome is left alone. */
export function patchOutcome(gh, branch, id, patch) {
  return update(gh, branch, (list) => {
    const i = list.findIndex((o) => o.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    return list;
  }, `snapgit metrics: update ${id}`);
}
