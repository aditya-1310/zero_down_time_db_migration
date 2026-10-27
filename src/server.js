import http from 'node:http';
import { openDb, getConfig, normalizeEmail } from './db.js';

// The orders API. Every request picks its read/write path from app_config
// INSIDE the same transaction as the data access, so an operator flipping a
// mode (or running contract DDL) from another process can never interleave
// with an in-flight request. That is what makes the cutover steps safe.

function upsertCustomer(db, rawName, rawEmail) {
  const email = normalizeEmail(rawEmail);
  db.prepare(
    'INSERT INTO customers (name, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
  ).run(rawName, email);
  return db.prepare('SELECT id FROM customers WHERE email = ?').get(email).id;
}

function insertOrder(db, body) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // write_mode is read under the write lock: the insert and the decision are
    // one atomic unit (EDD §5).
    const writeMode = getConfig(db, 'write_mode') ?? 'legacy';
    let customerId = null;

    if (writeMode === 'dual' || writeMode === 'new') {
      customerId = upsertCustomer(db, body.customer_name, body.customer_email);
    }

    let id;
    if (writeMode === 'legacy') {
      const r = db
        .prepare(
          'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
        )
        .run(body.customer_name, body.customer_email, body.amount_cents, 'new');
      id = Number(r.lastInsertRowid);
    } else if (writeMode === 'dual') {
      const r = db
        .prepare(
          'INSERT INTO orders (customer_name, customer_email, customer_id, amount_cents, status) VALUES (?, ?, ?, ?, ?)'
        )
        .run(body.customer_name, body.customer_email, customerId, body.amount_cents, 'new');
      id = Number(r.lastInsertRowid);
    } else {
      const r = db
        .prepare(
          'INSERT INTO orders (customer_id, amount_cents, status) VALUES (?, ?, ?)'
        )
        .run(customerId, body.amount_cents, 'new');
      id = Number(r.lastInsertRowid);
    }
    db.exec('COMMIT');
    return { id, customer_id: customerId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function listOrders(db, limit) {
  // Snapshot read: read_mode and rows come from one consistent view.
  db.exec('BEGIN DEFERRED');
  try {
    const readMode = getConfig(db, 'read_mode') ?? 'legacy';
    const orders =
      readMode === 'joined'
        ? db
            .prepare(
              `SELECT o.id, c.name AS customer_name, c.email AS customer_email,
                      o.amount_cents, o.status, o.created_at
                 FROM orders o JOIN customers c ON c.id = o.customer_id
                ORDER BY o.id DESC LIMIT ?`
            )
            .all(limit)
        : db
            .prepare(
              `SELECT id, customer_name, customer_email, amount_cents, status, created_at
                 FROM orders ORDER BY id DESC LIMIT ?`
            )
            .all(limit);
    db.exec('COMMIT');
    return { read_mode: readMode, orders };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function validateOrderBody(body) {
  const errors = [];
  const name = body?.customer_name;
  const email = body?.customer_email;
  const amount = body?.amount_cents;

  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) {
    errors.push('customer_name must be a string of 1-200 chars');
  }
  if (typeof email !== 'string' || !/^\s*[^@\s]+@[^@\s]+\.[^@\s]+\s*$/.test(email) || email.length > 320) {
    errors.push('customer_email must be a valid email');
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000_000) {
    errors.push('amount_cents must be an integer between 1 and 1000000000');
  }
  return errors;
}

export function createServer(db) {
  const startedAt = Date.now();
  let totalRequests = 0;
  let failedRequests = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    totalRequests++;

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        uptime_ms: Date.now() - startedAt,
        write_mode: getConfig(db, 'write_mode'),
        read_mode: getConfig(db, 'read_mode'),
      });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      return sendJson(res, 200, {
        uptime_ms: Date.now() - startedAt,
        total_requests: totalRequests,
        failed_requests: failedRequests,
        orders: db.prepare('SELECT count(*) AS c FROM orders').get().c,
        customers: tableExists(db, 'customers')
          ? db.prepare('SELECT count(*) AS c FROM customers').get().c
          : 0,
        orders_missing_customer_id: columnExists(db, 'orders', 'customer_id')
          ? db.prepare('SELECT count(*) AS c FROM orders WHERE customer_id IS NULL').get().c
          : null,
        write_mode: getConfig(db, 'write_mode'),
        read_mode: getConfig(db, 'read_mode'),
      });
    }

    if (req.method === 'GET' && url.pathname === '/orders') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 100);
      const result = listOrders(db, limit);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        failedRequests++;
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const errors = validateOrderBody(body);
      if (errors.length > 0) {
        failedRequests++;
        return sendJson(res, 400, { error: 'validation failed', details: errors });
      }
      try {
        const created = insertOrder(db, body);        return sendJson(res, 201, created);
      } catch (err) {
        failedRequests++;
        return sendJson(res, 500, { error: 'insert failed', detail: String(err.message ?? err) });
      }
    }

    failedRequests++;
    return sendJson(res, 404, { error: 'not found' });
  });

  return server;
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Run directly → start a standalone server (DB_PATH, PORT env vars).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const dbPath = process.env.DB_PATH ?? 'data/app.db';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dbPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  const db = openDb(dbPath);
  const { createBaselineSchema } = await import('./schema.js');
  createBaselineSchema(db);
  const port = parseInt(process.env.PORT ?? '3100', 10);
  createServer(db).listen(port, () => {
    process.stdout.write(`orders api listening on :${port} (db: ${dbPath})\n`);
  });
}
