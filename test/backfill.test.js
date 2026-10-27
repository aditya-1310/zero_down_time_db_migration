import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, setConfig } from '../src/db.js';
import { createBaselineSchema, seedOrders } from '../src/schema.js';
import { runBackfill } from '../src/lib/backfill.js';

// Tiny deterministic rng so seeded orders are identical on every machine/run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exact DDL `migrate expand` runs — copied verbatim from src/migrate.js so tests
// exercise the real schema shape.
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

function makeDb({ count = 0, seed = 42 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-'));
  const db = openDb(join(dir, 't.db'));
  createBaselineSchema(db);
  if (count > 0) seedOrders(db, count, { rng: mulberry32(seed) });
  expand(db);
  setConfig(db, 'write_mode', 'dual');
  return { db, dir };
}

function dispose(db, dir) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const one = (db, sql) => db.prepare(sql).get().c;

test('happy path: maps every order, FK intact, no duplicate customers', async () => {
  const { db, dir } = makeDb({ count: 200, seed: 7 });
  try {
    const logs = [];
    const stats = await runBackfill(db, {
      batchSize: 100,
      throttleMs: 1,
      log: (m) => logs.push(m),
    });

    assert.equal(stats.rowsMapped, 200);
    assert.equal(stats.batches, 2); // only non-empty batches count
    assert.ok(stats.customersCreated > 0);
    assert.equal(typeof stats.elapsedMs, 'number');
    assert.ok(stats.elapsedMs >= 0);
    assert.equal(logs.length, 2, 'log called once per non-empty batch');
    assert.ok(logs.every((m) => typeof m === 'string' && m.includes('batch')));

    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 0);
    // no orphan FKs (unmapped rows are NULL-joined, so exclude them)
    assert.equal(
      one(
        db,
        'SELECT count(*) AS c FROM orders o LEFT JOIN customers cu ON o.customer_id = cu.id WHERE o.customer_id IS NOT NULL AND cu.id IS NULL'
      ),
      0
    );
    // every mapped order's customer is the normalized form of its legacy email
    assert.equal(
      one(
        db,
        'SELECT count(*) AS c FROM orders o JOIN customers cu ON o.customer_id = cu.id WHERE cu.email != lower(trim(o.customer_email))'
      ),
      0
    );
    // exactly one customer per distinct normalized legacy email, no duplicates
    const totals = db.prepare('SELECT count(*) AS c, count(DISTINCT email) AS d FROM customers').get();
    assert.equal(totals.c, totals.d);
    assert.equal(
      totals.c,
      one(db, 'SELECT count(DISTINCT lower(trim(customer_email))) AS c FROM orders')
    );
  } finally {
    dispose(db, dir);
  }
});

test('normalization: dirty duplicate emails collapse into one customer', async () => {
  const { db, dir } = makeDb();
  try {
    const ins = db.prepare(
      'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
    );
    ins.run('Foo Bear', '  Foo@BAR.io ', 1000, 'new');
    ins.run('Foo B.', 'foo@bar.io', 2000, 'paid');

    const stats = await runBackfill(db, { throttleMs: 0 });
    assert.equal(stats.rowsMapped, 2);

    const customers = db.prepare('SELECT * FROM customers').all();
    assert.equal(customers.length, 1);
    assert.equal(customers[0].email, 'foo@bar.io');
    // first-write-wins: the name from the earliest order (lowest id) is kept
    assert.equal(customers[0].name, 'Foo Bear');

    const orders = db.prepare('SELECT customer_id FROM orders ORDER BY id').all();
    assert.equal(orders.length, 2);
    assert.ok(orders.every((o) => o.customer_id === customers[0].id));
  } finally {
    dispose(db, dir);
  }
});

test('idempotency: rerun after completion changes nothing', async () => {
  const { db, dir } = makeDb({ count: 200, seed: 3 });
  try {
    const first = await runBackfill(db, { batchSize: 100, throttleMs: 0 });
    assert.equal(first.rowsMapped, 200);
    const customersBefore = one(db, 'SELECT count(*) AS c FROM customers');

    const second = await runBackfill(db, { batchSize: 100, throttleMs: 0 });
    assert.equal(second.rowsMapped, 0);
    assert.equal(second.customersCreated, 0);
    assert.equal(second.batches, 0); // nothing to scan — clean drain

    assert.equal(one(db, 'SELECT count(*) AS c FROM customers'), customersBefore);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 0);
  } finally {
    dispose(db, dir);
  }
});

test('resume: stops at maxBatches, rerun drains the rest, no duplicates', async () => {
  const { db, dir } = makeDb({ count: 250, seed: 13 });
  try {
    const partial = await runBackfill(db, { batchSize: 100, throttleMs: 0, maxBatches: 2 });
    assert.equal(partial.rowsMapped, 200);
    assert.equal(partial.batches, 2);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 50);

    const rest = await runBackfill(db, { batchSize: 100, throttleMs: 0 });
    assert.equal(rest.rowsMapped, 50);
    assert.equal(rest.customersCreated >= 0, true); // later batches may be all repeats
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 0);

    const totals = db.prepare('SELECT count(*) AS c, count(DISTINCT email) AS d FROM customers').get();
    assert.equal(totals.c, totals.d);
    assert.equal(
      totals.c,
      one(db, 'SELECT count(DISTINCT lower(trim(customer_email))) AS c FROM orders')
    );
    assert.equal(
      one(
        db,
        'SELECT count(*) AS c FROM orders o LEFT JOIN customers cu ON o.customer_id = cu.id WHERE o.customer_id IS NOT NULL AND cu.id IS NULL'
      ),
      0
    );
  } finally {
    dispose(db, dir);
  }
});

test('crash-safety: a stopped batch leaves committed rows consistent, rerun finishes', async () => {
  const { db, dir } = makeDb({ count: 150, seed: 99 });
  try {
    const partial = await runBackfill(db, { batchSize: 100, throttleMs: 0, maxBatches: 1 });
    assert.equal(partial.rowsMapped, 100);
    assert.equal(partial.batches, 1);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 50);
    // what did commit is fully consistent — no half-mapped rows
    assert.equal(
      one(
        db,
        'SELECT count(*) AS c FROM orders o LEFT JOIN customers cu ON o.customer_id = cu.id WHERE o.customer_id IS NOT NULL AND cu.id IS NULL'
      ),
      0
    );

    // full run with default opts (batchSize 1000, throttleMs 15, no-op log)
    const rest = await runBackfill(db);
    assert.equal(rest.rowsMapped, 50);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 0);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders'), 150);
    const totals = db.prepare('SELECT count(*) AS c, count(DISTINCT email) AS d FROM customers').get();
    assert.equal(totals.c, totals.d);
  } finally {
    dispose(db, dir);
  }
});

test('poison rows: invalid emails/names are skipped and reported, not turned into customers', async () => {
  const { db, dir } = makeDb();
  try {
    const ins = db.prepare(
      'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
    );
    ins.run('Good One', 'good@one.io', 100, 'new');
    ins.run('Null Email', null, 200, 'new'); // would become customer "null"
    ins.run('Empty Email', '   ', 300, 'new'); // would merge people into ''
    ins.run('No At Sign', 'not-an-email', 400, 'new'); // no @ — not an address
    ins.run(null, 'noname@x.io', 500, 'new'); // customers.name NOT NULL would wedge the batch

    const stats = await runBackfill(db, { throttleMs: 0 });
    assert.equal(stats.rowsMapped, 1);
    assert.equal(stats.skipped, 4);
    assert.equal(stats.skipReasons.invalid_email, 3);
    assert.equal(stats.skipReasons.invalid_name, 1);

    // only the valid row got a customer; poison rows stay NULL for a human
    assert.equal(one(db, 'SELECT count(*) AS c FROM customers'), 1);
    assert.equal(one(db, "SELECT count(*) AS c FROM customers WHERE email IN ('null', '', 'not-an-email')"), 0);
    assert.equal(one(db, 'SELECT count(*) AS c FROM orders WHERE customer_id IS NULL'), 4);

    // rerun must terminate (keyset scan) and not loop forever on the skips
    const rerun = await runBackfill(db, { throttleMs: 0 });
    assert.equal(rerun.rowsMapped, 0);
    assert.equal(rerun.skipped, 4);
    assert.equal(rerun.batches, 1);
  } finally {
    dispose(db, dir);
  }
});

test('customersCreated counts creations exactly across same-email collisions', async () => {
  const { db, dir } = makeDb();
  try {
    const ins = db.prepare(
      'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
    );
    ins.run('A Person', 'same@person.io', 100, 'new');
    ins.run('Same Person', 'SAME@person.io', 200, 'new');
    ins.run('Same Again', '  same@person.io ', 300, 'new');

    const stats = await runBackfill(db, { throttleMs: 0 });
    assert.equal(stats.rowsMapped, 3);
    assert.equal(stats.customersCreated, 1); // one real insert, two conflicts
    assert.equal(one(db, 'SELECT count(*) AS c FROM customers'), 1);
  } finally {
    dispose(db, dir);
  }
});
