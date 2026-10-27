#!/usr/bin/env node
// Operator CLI — one subcommand per migration phase. Every mutating step has
// gates so it cannot run out of order. This CLI is what the runbook executes;
// the demo just runs it as a child process under live traffic.

import { openDb, getConfig, setConfig } from './db.js';
import { createBaselineSchema } from './schema.js';
import { markPhaseRunning, markPhaseDone, markPhaseFailed, getPhase, lastVerifyResult } from './lib/migration_state.js';
import { runVerify, formatVerify } from './verify.js';

const DB_PATH = process.env.DB_PATH ?? 'data/app.db';

function fail(msg, code = 2) {
  process.stderr.write(`migrate: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function requireExpanded(db) {
  if (!tableExists(db, 'customers') || !columnExists(db, 'orders', 'customer_id')) {
    fail('gate: schema is not expanded yet — run `migrate expand` first');
  }
}

// After write_mode=new, inserts stop providing the legacy columns — they must
// be nullable or every POST 500s. SQLite cannot ALTER a column to nullable in
// place (that's a 12-step table rebuild); fresh databases built by this repo
// already create them nullable. A pre-existing NOT NULL database needs the
// rebuild (or the Postgres equivalent, ALTER COLUMN ... DROP NOT NULL) first.
function requireLegacyColumnsNullable(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().filter((c) => ['customer_name', 'customer_email'].includes(c.name));
  const notNull = cols.filter((c) => c.notnull === 1);
  if (notNull.length > 0) {
    fail(
      `gate: orders.${notNull.map((c) => c.name).join(', ')} ${notNull.length === 1 ? 'is' : 'are'} NOT NULL — legacy columns must be nullable before writes stop (SQLite needs a table rebuild to relax this; see runbook §contract-prep)`
    );
  }
}

function requireVerifyPassed(db) {
  const v = lastVerifyResult(db);
  if (!v || !v.passed) {
    fail('gate: no passing verify on record — run `migrate verify` and confirm it passes');
  }
  return v;
}

const commands = {
  expand(db) {
    markPhaseRunning(db, 'expand');
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    if (!columnExists(db, 'orders', 'customer_id')) {
      db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id);');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);');
    markPhaseDone(db, 'expand', { customers_table: true, orders_customer_id: true });
    info('expand: customers table + orders.customer_id added (additive, no locks held on live rows)');
  },

  async backfill(db, opts) {
    requireExpanded(db);
    const writeMode = getConfig(db, 'write_mode');
    if (writeMode !== 'dual' && !opts.force) {
      fail(
        `gate: write_mode is '${writeMode}', dual-write must be enabled first or NULL rows will keep appearing behind the backfill (override with --force)`
      );
    }
    markPhaseRunning(db, 'backfill');
    info(`backfill: starting (batch_size=${opts.batchSize}, throttle_ms=${opts.throttleMs})`);
    const { runBackfill } = await import('./lib/backfill.js');
    try {
      const stats = await runBackfill(db, {
        batchSize: opts.batchSize,
        throttleMs: opts.throttleMs,
        log: (m) => info(`backfill: ${m}`),
      });
      markPhaseDone(db, 'backfill', stats);
      info(
        `backfill: done — ${stats.rowsMapped} rows mapped, ${stats.customersCreated} customers created in ${stats.batches} batches (${stats.elapsedMs}ms)`
      );
      if (stats.skipped > 0) {
        const reasons = Object.entries(stats.skipReasons).map(([r, n]) => `${r}: ${n}`).join(', ');
        info(
          `backfill: WARNING — ${stats.skipped} rows skipped (${reasons}). They stay unmapped on purpose; verify will FAIL until the data is fixed or the rows are excluded.`
        );
      }
    } catch (err) {
      markPhaseFailed(db, 'backfill', { error: String(err) });
      throw err;
    }
  },

  verify(db) {
    requireExpanded(db);
    markPhaseRunning(db, 'verify');
    let result;
    try {
      result = runVerify(db);
    } catch (err) {
      markPhaseFailed(db, 'verify', { error: String(err) });
      throw err;
    }
    if (result.passed) {
      markPhaseDone(db, 'verify', result);
    } else {
      markPhaseFailed(db, 'verify', result);
    }
    info(formatVerify(result));
    if (!result.passed) {
      fail('verify: FAILED — cutover gates stay closed', 1);
    }
    info('verify: all checks passed');
  },

  'enable-dual'(db) {
    requireExpanded(db);
    setConfig(db, 'write_mode', 'dual');
    markPhaseDone(db, 'enable-dual', { write_mode: 'dual' });
    info('enable-dual: app now writes legacy columns AND customer_id in one txn (rollback: migrate rollback-dual)');
  },

  'switch-reads'(db) {
    requireExpanded(db);
    requireVerifyPassed(db);
    // Joined reads JOIN on customer_id, so any row written without one
    // (write_mode=legacy) would silently vanish from listings. Reads may only
    // cut over while dual-write is on or legacy writes already stopped.
    const writeMode = getConfig(db, 'write_mode');
    if (writeMode === 'legacy') {
      fail("gate: write_mode is 'legacy' — dual-write must be on before reads cut over, or every order written from now on would be invisible to joined reads");
    }
    setConfig(db, 'read_mode', 'joined');
    markPhaseDone(db, 'switch-reads', { read_mode: 'joined' });
    info('switch-reads: reads now JOIN customers (rollback: migrate rollback-reads)');
  },

  'stop-legacy-writes'(db) {
    requireExpanded(db);
    requireVerifyPassed(db);
    requireLegacyColumnsNullable(db);
    if (getConfig(db, 'read_mode') !== 'joined') {
      fail('gate: reads must be cut over to joined before legacy writes stop (read_mode=joined)');
    }
    setConfig(db, 'write_mode', 'new');
    markPhaseDone(db, 'stop-legacy-writes', { write_mode: 'new' });
    info('stop-legacy-writes: app no longer writes customer_name/customer_email');
  },

  contract(db, opts) {
    requireExpanded(db);
    requireVerifyPassed(db);
    if (getConfig(db, 'write_mode') !== 'new') {
      fail('gate: write_mode must be \'new\' before dropping legacy columns (app would still write them)');
    }
    if (!opts.yes) {
      fail('contract is the point of no return — run `migrate contract --yes` after the runbook pre-contract checklist');
    }
    markPhaseRunning(db, 'contract');
    db.exec('ALTER TABLE orders DROP COLUMN customer_name;');
    db.exec('ALTER TABLE orders DROP COLUMN customer_email;');
    markPhaseDone(db, 'contract', { dropped: ['customer_name', 'customer_email'] });
    info('contract: legacy columns dropped. Migration complete.');
  },

  'rollback-dual'(db) {
    if (getConfig(db, 'read_mode') === 'joined') {
      fail('gate: reads are already on joined — rollback reads first (migrate rollback-reads), or rows written in legacy mode would be invisible');
    }
    setConfig(db, 'write_mode', 'legacy');
    info('rollback-dual: write_mode=legacy (safe: legacy columns were still being written)');
  },

  'rollback-reads'(db) {
    if (!columnExists(db, 'orders', 'customer_email')) {
      fail('cannot rollback reads after contract — legacy columns are gone');
    }
    setConfig(db, 'read_mode', 'legacy');
    info('rollback-reads: read_mode=legacy');
  },

  status(db) {
    const writeMode = getConfig(db, 'write_mode');
    const readMode = getConfig(db, 'read_mode');
    info(`config:   write_mode=${writeMode} read_mode=${readMode}`);
    info(`expanded: ${tableExists(db, 'customers') && columnExists(db, 'orders', 'customer_id')}`);
    if (columnExists(db, 'orders', 'customer_id')) {
      const c = db
        .prepare(
          `SELECT count(*) AS total,
                  sum(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS unmapped
             FROM orders`
        )
        .get();
      info(`orders:   ${c.total} total, ${c.unmapped} not yet mapped`);
    }
    if (tableExists(db, 'customers')) {
      info(`customers: ${db.prepare('SELECT count(*) AS c FROM customers').get().c}`);
    }
    for (const phase of ['expand', 'enable-dual', 'backfill', 'verify', 'switch-reads', 'stop-legacy-writes', 'contract']) {
      const p = getPhase(db, phase);
      if (p) info(`phase ${phase.padEnd(19)} ${p.status} (${p.started_at} → ${p.finished_at ?? '…'})`);
    }
    const v = lastVerifyResult(db);
    if (v) info(`last verify: ${v.passed ? 'PASS' : 'FAIL'} at ${v.at}`);
  },
};

const args = process.argv.slice(2);
const command = args[0];
if (!command || !commands[command]) {
  process.stderr.write(`usage: migrate <expand|enable-dual|backfill|verify|switch-reads|stop-legacy-writes|contract|rollback-dual|rollback-reads|status> [options]
  backfill [--batch-size N] [--throttle-ms N] [--force]
  contract [--yes]
env: DB_PATH (default data/app.db)
`);
  process.exit(2);
}

function parseOpts(rest) {
  const opts = { batchSize: 1000, throttleMs: 15, force: false, yes: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--batch-size') opts.batchSize = parseInt(rest[++i], 10);
    else if (rest[i] === '--throttle-ms') opts.throttleMs = parseInt(rest[++i], 10);
    else if (rest[i] === '--force') opts.force = true;
    else if (rest[i] === '--yes') opts.yes = true;
  }
  return opts;
}

const { mkdirSync } = await import('node:fs');
mkdirSync(DB_PATH.split('/').slice(0, -1).join('/') || '.', { recursive: true });
const db = openDb(DB_PATH);
createBaselineSchema(db);
try {
  await commands[command](db, parseOpts(args.slice(1)));
} catch (err) {
  fail(String(err.message ?? err), 1);
}
