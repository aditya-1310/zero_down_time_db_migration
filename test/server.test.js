import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, setConfig } from '../src/db.js';
import { createBaselineSchema } from '../src/schema.js';
import { createServer } from '../src/server.js';
import { runBackfill } from '../src/lib/backfill.js';
import { runVerify } from '../src/verify.js';

// Integration coverage for the riskiest logic in the system: the per-request
// mode selection. Each test flips write_mode/read_mode exactly the way the
// operator CLI does and asserts what the API wrote/read.

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'srv-'));
  const db = openDb(join(dir, 't.db'));
  createBaselineSchema(db);
  const server = createServer(db);
  return { db, dir, server };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function teardown(db, dir, server) {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

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

const post = (base, body) =>
  fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (base, path) => fetch(`${base}${path}`);

test('write modes: legacy -> dual -> new produce the exact column sets the EDD promises', async () => {
  const { db, dir, server } = setup();
  const base = await listen(server);
  try {
    // legacy: old columns only, no customer rows
    let res = await post(base, { customer_name: 'Legacy Mode', customer_email: 'legacy@mode.io', amount_cents: 100 });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).customer_id, null);
    let row = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.customer_name, 'Legacy Mode');
    assert.equal(row.customer_id, undefined); // column does not exist yet — expand hasn't run
    assert.equal(db.prepare('SELECT count(*) AS c FROM sqlite_master').get().c > 0, true);

    // dual: upsert customer + BOTH column sets, email normalized on the customer
    expand(db);
    setConfig(db, 'write_mode', 'dual');
    res = await post(base, { customer_name: 'Dual Mode', customer_email: '  DUAL@Mode.IO ', amount_cents: 200 });
    const dual = await res.json();
    assert.equal(dual.customer_id, 1);
    row = db.prepare('SELECT * FROM orders WHERE id = ?').get(dual.id);
    assert.equal(row.customer_name, 'Dual Mode');
    assert.equal(row.customer_email, '  DUAL@Mode.IO '); // legacy col keeps raw value
    const customer = db.prepare('SELECT * FROM customers').get();
    assert.equal(customer.email, 'dual@mode.io'); // normalized identity
    assert.equal(customer.name, 'Dual Mode');

    // same email again -> same customer id, no duplicate
    res = await post(base, { customer_name: 'Dual Again', customer_email: 'dual@mode.io', amount_cents: 300 });
    assert.equal((await res.json()).customer_id, 1);
    assert.equal(db.prepare('SELECT count(*) AS c FROM customers').get().c, 1);

    // new: legacy columns stay NULL, customer still written
    setConfig(db, 'write_mode', 'new');
    res = await post(base, { customer_name: 'New Mode', customer_email: 'new@mode.io', amount_cents: 400 });
    const nu = await res.json();
    assert.ok(nu.customer_id > 1);
    row = db.prepare('SELECT * FROM orders WHERE id = ?').get(nu.id);
    assert.equal(row.customer_name, null);
    assert.equal(row.customer_email, null);
    assert.ok(row.customer_id > 0);
  } finally {
    await teardown(db, dir, server);
  }
});

test('read modes: legacy read then joined read, joined shows normalized identity', async () => {
  const { db, dir, server } = setup();
  const base = await listen(server);
  try {
    expand(db);
    setConfig(db, 'write_mode', 'dual');
    await post(base, { customer_name: 'Reader Person', customer_email: '  READER@person.io ', amount_cents: 100 });
    // the one legacy-mode row from the "before times" that backfill will fix
    db.prepare(
      'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
    ).run('Backfill Me', 'backfill@me.io', 100, 'new');
    await runBackfill(db, { throttleMs: 0 });

    // legacy read: straight off the old columns
    let res = await get(base, '/orders?limit=10');
    let body = await res.json();
    assert.equal(body.read_mode, 'legacy');
    assert.ok(body.orders.some((o) => o.customer_email === '  READER@person.io '));

    // joined read: identity comes from customers (normalized)
    setConfig(db, 'read_mode', 'joined');
    res = await get(base, '/orders?limit=10');
    body = await res.json();
    assert.equal(body.read_mode, 'joined');
    assert.ok(body.orders.some((o) => o.customer_email === 'reader@person.io'));
    assert.ok(body.orders.some((o) => o.customer_email === 'backfill@me.io')); // backfilled row joins fine
    assert.ok(body.orders.every((o) => typeof o.customer_name === 'string'));
  } finally {
    await teardown(db, dir, server);
  }
});

test('full sequence invariants: verify passes after legacy->dual->backfill->joined->new', async () => {
  const { db, dir, server } = setup();
  const base = await listen(server);
  try {
    expand(db);
    setConfig(db, 'write_mode', 'dual');
    await post(base, { customer_name: 'One', customer_email: 'one@x.io', amount_cents: 100 });
    setConfig(db, 'write_mode', 'new');
    await post(base, { customer_name: 'Two', customer_email: 'TWO@x.io', amount_cents: 200 });
    db.prepare(
      'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
    ).run('Old Row', 'old@row.io', 300, 'new');
    await runBackfill(db, { throttleMs: 0 });

    setConfig(db, 'read_mode', 'joined');
    const result = runVerify(db);
    assert.ok(result.passed, JSON.stringify(result.checks));
  } finally {
    await teardown(db, dir, server);
  }
});

test('verify catches tampering: an unmapped order fails the gate', async () => {
  const { db, dir, server } = setup();
  await listen(server);
  try {
    expand(db);
    db.prepare('INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)').run(
      'Orphan',
      'orphan@x.io',
      100,
      'new'
    );
    const result = runVerify(db);
    assert.equal(result.passed, false);
    assert.equal(result.checks.find((c) => c.name === 'no_unmapped_orders').ok, false);
  } finally {
    await teardown(db, dir, server);
  }
});

test('validation and routing: bad payloads 400, unknown routes 404, health works', async () => {
  const { db, dir, server } = setup();
  const base = await listen(server);
  try {
    let res = await post(base, { customer_name: '', customer_email: 'nope', amount_cents: -5 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(Array.isArray(body.details) && body.details.length === 3);

    res = await get(base, '/nope');
    assert.equal(res.status, 404);

    res = await get(base, '/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    await teardown(db, dir, server);
  }
});
