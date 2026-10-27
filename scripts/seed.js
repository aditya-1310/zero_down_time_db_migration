// Seed a "legacy production" database: baseline v1 schema + N dirty orders.
// usage: node scripts/seed.js [--count 25000] [--db data/app.db]
import { openDb } from '../src/db.js';
import { createBaselineSchema, seedOrders } from '../src/schema.js';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const count = parseInt(opt('--count', '25000'), 10);
const dbPath = opt('--db', 'data/app.db');

const { mkdirSync } = await import('node:fs');
mkdirSync(dbPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });

const db = openDb(dbPath);
createBaselineSchema(db);
const t0 = Date.now();
const inserted = seedOrders(db, count);
process.stdout.write(
  `seeded ${inserted} orders into ${dbPath} in ${Date.now() - t0}ms (mixed-case emails, whitespace, shared mailboxes included)\n`
);
