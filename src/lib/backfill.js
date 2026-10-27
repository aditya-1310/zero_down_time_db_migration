// Batched, throttled, idempotent, crash-resumable backfill (EDD §5): map legacy
// orders.customer_name/customer_email rows onto the normalized customers table.
// The `customer_id IS NULL` predicate IS the cursor — there is no separate
// progress state, so a crash anywhere resumes by simply rerunning.

import { normalizeEmail } from '../db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same email shape the API enforces (server.js validateOrderBody) — a poison
// legacy row must never become a customer: 'null'/'' emails would merge
// distinct people, and a NULL name would violate customers.name NOT NULL and
// wedge the batch forever.
const emailIsValid = (email) =>
  typeof email === 'string' && email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
const nameIsValid = (name) => typeof name === 'string' && name.trim().length >= 1 && name.length <= 200;

export async function runBackfill(db, opts = {}) {
  const batchSize = opts.batchSize ?? 1000;
  const throttleMs = opts.throttleMs ?? 15;
  const maxBatches = opts.maxBatches ?? Infinity;
  const log = opts.log ?? (() => {});

  const selectBatch = db.prepare(
    'SELECT id, customer_name, customer_email FROM orders WHERE customer_id IS NULL AND id > ? ORDER BY id LIMIT ?'
  );
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
  );
  const selectCustomerId = db.prepare('SELECT id FROM customers WHERE email = ?');
  const updateOrder = db.prepare(
    'UPDATE orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL'
  );

  const stats = { rowsMapped: 0, customersCreated: 0, batches: 0, elapsedMs: 0, skipped: 0, skipReasons: {} };
  const startedAt = Date.now();

  // Keyset scan: `customer_id IS NULL` alone would re-select skipped poison
  // rows forever, so each run walks ids in order with an in-memory cursor.
  // Reruns still pick up anything left unmapped (skips, or legacy-mode
  // inserts under --force — AUTOINCREMENT ids are always above this cursor).
  let cursor = 0;
  while (stats.batches < maxBatches) {
    const rows = selectBatch.all(cursor, batchSize);
    if (rows.length === 0) break;
    stats.batches += 1;
    cursor = rows[rows.length - 1].id;

    db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (!emailIsValid(row.customer_email) || !nameIsValid(row.customer_name)) {
          // Skipped rows keep customer_id NULL — verify will (correctly) fail
          // and hold the cutover gates closed until a human fixes the data.
          const reason = !nameIsValid(row.customer_name) ? 'invalid_name' : 'invalid_email';
          stats.skipped += 1;
          stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
          continue;
        }
        const email = normalizeEmail(row.customer_email);
        // First-write-wins by design (EDD §4): changes === 0 means this email
        // already had a customer and we keep its original name.
        const inserted = insertCustomer.run(row.customer_name, email);
        if (inserted.changes > 0) stats.customersCreated += 1;
        // Insert the customer BEFORE linking the order — FK would reject the
        // update otherwise.
        const customer = selectCustomerId.get(email);
        stats.rowsMapped += Number(updateOrder.run(customer.id, row.id).changes);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* BEGIN itself failed — nothing to roll back */
      }
      throw err;
    }

    log(`batch ${stats.batches}: ${rows.length} rows scanned (${stats.rowsMapped} mapped${stats.skipped ? `, ${stats.skipped} skipped` : ''})`);

    // Throttle only AFTER commit — never while holding the write lock (EDD §7).
    if (throttleMs > 0) await sleep(throttleMs);
  }

  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}
