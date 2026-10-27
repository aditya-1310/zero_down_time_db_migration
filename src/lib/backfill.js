// Batched, throttled, idempotent, crash-resumable backfill (EDD §5): map legacy
// orders.customer_name/customer_email rows onto the normalized customers table.
// The `customer_id IS NULL` predicate IS the cursor — there is no separate
// progress state, so a crash anywhere resumes by simply rerunning.

import { normalizeEmail } from '../db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBackfill(db, opts = {}) {
  const batchSize = opts.batchSize ?? 1000;
  const throttleMs = opts.throttleMs ?? 15;
  const maxBatches = opts.maxBatches ?? Infinity;
  const log = opts.log ?? (() => {});

  const selectBatch = db.prepare(
    'SELECT id, customer_name, customer_email FROM orders WHERE customer_id IS NULL ORDER BY id LIMIT ?'
  );
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
  );
  const selectCustomerId = db.prepare('SELECT id FROM customers WHERE email = ?');
  const updateOrder = db.prepare(
    'UPDATE orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL'
  );

  const stats = { rowsMapped: 0, customersCreated: 0, batches: 0, elapsedMs: 0 };
  const startedAt = Date.now();

  while (stats.batches < maxBatches) {
    const rows = selectBatch.all(batchSize);
    stats.batches += 1; // the terminating empty SELECT counts as the final check batch
    if (rows.length === 0) break;

    db.exec('BEGIN');
    try {
      for (const row of rows) {
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
      db.exec('ROLLBACK');
      throw err;
    }

    log(`batch ${stats.batches}: ${rows.length} rows mapped (${stats.rowsMapped} total)`);

    // Throttle only AFTER commit — never while holding the write lock (EDD §7).
    if (throttleMs > 0) await sleep(throttleMs);
  }

  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}
