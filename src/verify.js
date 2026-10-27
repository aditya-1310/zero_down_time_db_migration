// Invariant checker — the gate between "we think the data is mapped" and
// "we are allowed to cut reads over / drop columns". Read-only.

export function runVerify(db) {
  const q = (sql) => db.prepare(sql).get();

  const counts = {
    orders: q('SELECT count(*) AS c FROM orders').c,
    unmapped_orders: q('SELECT count(*) AS c FROM orders WHERE customer_id IS NULL').c,
    customers: q('SELECT count(*) AS c FROM customers').c,
  };

  const checks = [
    {
      name: 'no_unmapped_orders',
      expected: '0 orders with customer_id IS NULL',
      actual: `${counts.unmapped_orders}`,
      ok: counts.unmapped_orders === 0,
    },
    {
      name: 'no_orphan_orders',
      expected: '0 orders pointing at a missing customer',
      actual: `${q(`SELECT count(*) AS c FROM orders o
                     LEFT JOIN customers c ON c.id = o.customer_id
                    WHERE o.customer_id IS NOT NULL AND c.id IS NULL`).c}`,
      ok: false, // filled below
    },
    {
      name: 'email_mapping_intact',
      expected: '0 joined rows where lower(trim(legacy email)) != customers.email',
      actual: `${q(`SELECT count(*) AS c FROM orders o
                     JOIN customers c ON c.id = o.customer_id
                    WHERE lower(trim(o.customer_email)) != c.email`).c}`,
      ok: false,
    },
    {
      name: 'no_duplicate_customers',
      expected: 'customers.email has no duplicates (UNIQUE enforced, belt and braces)',
      actual: `${q('SELECT count(*) AS c FROM (SELECT email FROM customers GROUP BY email HAVING count(*) > 1)').c}`,
      ok: false,
    },
    {
      name: 'no_invalid_customers',
      expected: '0 customers with an invalid email shape or empty name (poison-row guard)',
      actual: `${q(`SELECT count(*) AS c FROM customers
                    WHERE email = '' OR email NOT LIKE '%@%.%'
                       OR name IS NULL OR trim(name) = ''`).c}`,
      ok: false,
    },
  ];
  checks[1].ok = checks[1].actual === '0';
  checks[2].ok = checks[2].actual === '0';
  checks[3].ok = checks[3].actual === '0';
  checks[4].ok = checks[4].actual === '0';

  return {
    passed: checks.every((c) => c.ok),
    checks,
    counts,
    at: new Date().toISOString(),
  };
}

export function formatVerify(result) {
  const lines = [];
  for (const c of result.checks) {
    lines.push(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — expected ${c.expected}, got ${c.actual}`);
  }
  lines.push(
    `  counts: ${result.counts.orders} orders, ${result.counts.customers} customers, ${result.counts.unmapped_orders} unmapped`
  );
  return lines.join('\n');
}
