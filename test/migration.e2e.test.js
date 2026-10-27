import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, setConfig } from '../src/db.js';
import { createBaselineSchema, seedOrders } from '../src/schema.js';
import { createServer } from '../src/server.js';
import { LoadGenerator } from '../src/loadgen.js';
import { runBackfill } from '../src/lib/backfill.js';
import { runVerify } from '../src/verify.js';

// EDD §9 success criterion: the FULL expand -> contract sequence under
// concurrent live traffic with zero failed requests. This is the test form of
// `npm run demo` — everything in-process, so a regression here fails CI and
// not just a manual run.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expand(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);');
}

test('e2e: full migration under live traffic — zero failed requests, data intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const db = openDb(join(dir, 't.db'));
  createBaselineSchema(db);
  seedOrders(db, 400);
  expand(db); // expand BEFORE traffic so all write modes are exercisable

  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const load = new LoadGenerator({ baseUrl: base, concurrency: 3, writeRatio: 0.5 });
  try {
    load.start();
    await sleep(150); // traffic flowing in legacy mode

    setConfig(db, 'write_mode', 'dual');
    await sleep(150); // dual-write traffic

    const backfillStats = await runBackfill(db, { batchSize: 50, throttleMs: 1 });
    assert.ok(backfillStats.rowsMapped >= 400, `expected the seed rows mapped, got ${backfillStats.rowsMapped}`);
    assert.equal(backfillStats.skipped, 0);

    // gate: verify must pass before reads move
    let v = runVerify(db);
    assert.ok(v.passed, JSON.stringify(v.checks));
    setConfig(db, 'read_mode', 'joined');
    await sleep(150); // joined-read traffic

    setConfig(db, 'write_mode', 'new');
    await sleep(150); // new-write traffic

    v = runVerify(db);
    assert.ok(v.passed, JSON.stringify(v.checks));

    // contract — the point of no return, while traffic is still flowing
    db.exec('ALTER TABLE orders DROP COLUMN customer_name;');
    db.exec('ALTER TABLE orders DROP COLUMN customer_email;');
    await sleep(150); // traffic on the final schema

    const snap = await load.stop();

    // THE zero-downtime assertion
    assert.equal(snap.fail, 0, `load saw failures: ${JSON.stringify(snap.failByType)}`);
    assert.ok(snap.total >= 25, `expected meaningful traffic volume, got ${snap.total}`);

    // data integrity on the final schema
    assert.equal(db.prepare('SELECT count(*) AS c FROM orders WHERE customer_id IS NULL').get().c, 0);
    assert.equal(
      db
        .prepare(
          'SELECT count(*) AS c FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE o.customer_id IS NOT NULL AND c.id IS NULL'
        )
        .get()
        .c,
      0
    );
    const totals = db.prepare('SELECT count(*) AS c, count(DISTINCT email) AS d FROM customers').get();
    assert.equal(totals.c, totals.d);
    assert.ok(totals.c >= 1);
  } finally {
    await load.stop().catch(() => {});
    await new Promise((r) => server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
