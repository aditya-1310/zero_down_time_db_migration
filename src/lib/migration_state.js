// migration_state: durable record of which phases ran, when, and what they did.
// The operator CLI is the only writer; verify results are stored here too so
// downstream gates (switch-reads, contract) can require a fresh pass.

const nowIso = () => new Date().toISOString();

export function markPhaseRunning(db, phase) {
  db.prepare(
    `INSERT INTO migration_state (phase, status, started_at, finished_at, stats)
     VALUES (?, 'running', ?, NULL, NULL)
     ON CONFLICT(phase) DO UPDATE SET status = 'running', started_at = excluded.started_at, finished_at = NULL`
  ).run(phase, nowIso());
}

export function markPhaseDone(db, phase, stats) {
  db.prepare(
    `UPDATE migration_state SET status = 'done', finished_at = ?, stats = ? WHERE phase = ?`
  ).run(nowIso(), JSON.stringify(stats ?? {}), phase);
}

export function markPhaseFailed(db, phase, stats) {
  db.prepare(
    `UPDATE migration_state SET status = 'failed', finished_at = ?, stats = ? WHERE phase = ?`
  ).run(nowIso(), JSON.stringify(stats ?? {}), phase);
}

export function getPhase(db, phase) {
  const row = db.prepare('SELECT * FROM migration_state WHERE phase = ?').get(phase);
  if (!row) return null;
  return { ...row, stats: row.stats ? JSON.parse(row.stats) : null };
}

export function lastVerifyResult(db) {
  const phase = getPhase(db, 'verify');
  if (!phase || phase.status !== 'done') return null;
  return phase.stats; // { passed, checks, counts, at }
}
