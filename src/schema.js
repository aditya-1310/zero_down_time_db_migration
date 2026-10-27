// Baseline (v1) schema — the "legacy production" state. The customers table and
// orders.customer_id are added later by `migrate expand`, never here.
export function createBaselineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migration_state (
      phase       TEXT PRIMARY KEY,
      status      TEXT NOT NULL, -- pending | running | done
      started_at  TEXT,
      finished_at TEXT,
      stats       TEXT -- JSON blob, free-form per phase
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name  TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'new',
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
  `);

  // write_mode: legacy (old cols only) | dual (old + customer_id) | new (customer_id only)
  // read_mode:  legacy (old cols)      | joined (JOIN customers)
  const defaults = [
    ['write_mode', 'legacy'],
    ['read_mode', 'legacy'],
  ];
  for (const [key, value] of defaults) {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
    ).run(key, value);
  }
}

export function seedOrders(db, count, { rng = Math.random } = {}) {
  const firstNames = ['ana', 'raj', 'sam', 'leo', 'mia', 'noah', 'zoe', 'kai', 'ira', 'dev'];
  const lastNames = ['shah', 'patel', 'kim', 'silva', 'costa', 'rossi', 'chan', 'moreau', 'novak', 'rao'];
  const domains = ['corp.io', 'mail.com', 'shop.dev', 'old-billing.example', 'fastmail.test'];
  const statuses = ['new', 'paid', 'shipped', 'refunded'];

  const insert = db.prepare(
    'INSERT INTO orders (customer_name, customer_email, amount_cents, status) VALUES (?, ?, ?, ?)'
  );

  const rows = [];
  for (let i = 0; i < count; i++) {
    const first = firstNames[Math.floor(rng() * firstNames.length)];
    const last = lastNames[Math.floor(rng() * lastNames.length)];
    const domain = domains[Math.floor(rng() * domains.length)];

    // Deliberately dirty data, the way legacy tables always look:
    // mixed case emails, occasional whitespace padding, shared mailboxes
    // (same person under different spellings) once the customer base grows.
    let email = `${first}.${last}@${domain}`;
    const dirt = rng();
    if (dirt < 0.25) email = email.toUpperCase();
    else if (dirt < 0.4) email = `  ${email} `;
    else if (dirt < 0.5) email = `${first}${Math.floor(rng() * 90 + 10)}@${domain}`;

    const name = `${first} ${last}`;
    const amount = Math.floor(rng() * 48000) + 100;
    const status = statuses[Math.floor(rng() * statuses.length)];
    rows.push([name, email, amount, status]);
  }

  db.exec('BEGIN');
  try {
    for (const row of rows) insert.run(...row);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}
