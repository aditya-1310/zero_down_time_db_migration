# Zero-downtime migration demo report

- generated: 2026-10-27T22:41:00.520Z
- mode: normal
- db: D:\zero_dt\data\demo.db · seed: 3,000 orders · api: http://127.0.0.1:3123
- elapsed wall time: 8.9s

## MIGRATION RESULT: SUCCESS

Zero-downtime assertion holds: **0 failed requests out of 18,874 (0.00%)** across the full expand → contract run under continuous live traffic.

## Timeline

| phase | started (UTC) | duration | requests during phase | failures during phase |
|---|---|---|---|---|
| expand | 2026-10-27T22:40:53.933Z | 86 ms | 163 | 0 |
| enable-dual | 2026-10-27T22:40:54.019Z | 76 ms | 175 | 0 |
| backfill | 2026-10-27T22:40:54.095Z | 364 ms | 529 | 0 |
| verify | 2026-10-27T22:40:54.459Z | 130 ms | 317 | 0 |
| switch-reads | 2026-10-27T22:40:54.589Z | 78 ms | 182 | 0 |
| soak-v2-reads | 2026-10-27T22:40:54.669Z | 4001 ms | 8,581 | 0 |
| stop-legacy-writes | 2026-10-27T22:40:58.670Z | 82 ms | 161 | 0 |
| verify-post-cutover | 2026-10-27T22:40:58.752Z | 78 ms | 143 | 0 |
| contract | 2026-10-27T22:40:58.831Z | 104 ms | 183 | 0 |

Notable events:
- 2026-10-27T22:40:51.763Z — server-stdout: orders api listening on :3123 (db: D:\zero_dt\data\demo.db)
- 2026-10-27T22:40:51.927Z — server healthy (GET /health -> 200)
- 2026-10-27T22:40:51.930Z — load started (concurrency=4, writeRatio=0.3)
- 2026-10-27T22:40:53.933Z — warmup done (5206 requests, 0 failures)
- 2026-10-27T22:40:53.933Z — phase expand ok (86ms, 163 requests, 0 failures)
- 2026-10-27T22:40:54.019Z — phase enable-dual ok (76ms, 175 requests, 0 failures)
- 2026-10-27T22:40:54.095Z — phase backfill ok (364ms, 529 requests, 0 failures)
- 2026-10-27T22:40:54.459Z — phase verify ok (130ms, 317 requests, 0 failures)
- 2026-10-27T22:40:54.589Z — phase switch-reads ok (78ms, 182 requests, 0 failures)
- 2026-10-27T22:40:54.669Z — spot check: read_mode=joined, 5 orders
- 2026-10-27T22:40:54.669Z — phase soak-v2-reads ok (4001ms, 8581 requests, 0 failures)
- 2026-10-27T22:40:58.670Z — phase stop-legacy-writes ok (82ms, 161 requests, 0 failures)
- 2026-10-27T22:40:58.752Z — phase verify-post-cutover ok (78ms, 143 requests, 0 failures)
- 2026-10-27T22:40:58.831Z — phase contract ok (104ms, 183 requests, 0 failures)
- 2026-10-27T22:41:00.437Z — load stopped (18,874 total, 0 failures)
- 2026-10-27T22:41:00.454Z — server stopped (SIGTERM)

Read-cutover spot check (2026-10-27T22:40:54.669Z): `GET /orders?limit=5` → read_mode=**joined**, 5 orders returned.

## Latency (p50 / p95 / p99 / max, ms — nearest-rank over raw per-request samples)

| window | samples | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| overall (whole run) | 18,874 | 2 | 3 | 5 | 39 |
| backfill phase window | 529 | 2 | 6 | 28 | 39 |
| contract phase window | 183 | 2 | 5 | 16 | 16 |

## Totals

- load generator: 18,874 requests · 18,874 ok · 0 fail · error rate 0.00%
- load run duration: 8.5s
- warmup (2s before first phase): 5,206 requests, 0 failures
- server-side cross-check: 18,877 requests served, 0 rejected/errored
- database at end: 8,716 orders · 792 customers · write_mode=new · read_mode=joined
- elapsed wall time: 8.9s

## Operator CLI output per phase

### expand — 2026-10-27T22:40:53.933Z · 86 ms · exit 0

```
expand: customers table + orders.customer_id added (additive, no locks held on live rows)
```

### enable-dual — 2026-10-27T22:40:54.019Z · 76 ms · exit 0

```
enable-dual: app now writes legacy columns AND customer_id in one txn (rollback: migrate rollback-dual)
```

### backfill — 2026-10-27T22:40:54.095Z · 364 ms · exit 0

```
backfill: starting (batch_size=1000, throttle_ms=15)
backfill: batch 1: 1000 rows mapped (1000 total)
backfill: batch 2: 1000 rows mapped (2000 total)
backfill: batch 3: 1000 rows mapped (3000 total)
backfill: batch 4: 1000 rows mapped (4000 total)
backfill: batch 5: 685 rows mapped (4685 total)
backfill: done — 4685 rows mapped, 734 customers created in 6 batches (281ms)
```

### verify — 2026-10-27T22:40:54.459Z · 130 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  counts: 4938 orders, 792 customers, 0 unmapped
verify: all checks passed
```

### switch-reads — 2026-10-27T22:40:54.589Z · 78 ms · exit 0

```
switch-reads: reads now JOIN customers (rollback: migrate rollback-reads)
```

### soak-v2-reads — 2026-10-27T22:40:54.669Z · 4001 ms · exit 0

```
soaking live traffic on joined reads for 4000ms (no CLI action)
```

### stop-legacy-writes — 2026-10-27T22:40:58.670Z · 82 ms · exit 0

```
stop-legacy-writes: app no longer writes customer_name/customer_email
```

### verify-post-cutover — 2026-10-27T22:40:58.752Z · 78 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  counts: 7685 orders, 792 customers, 0 unmapped
verify: all checks passed
```

### contract — 2026-10-27T22:40:58.831Z · 104 ms · exit 0

```
contract: legacy columns dropped. Migration complete.
```

## Server output (captured from the API child process)

- [server-stdout] orders api listening on :3123 (db: D:\zero_dt\data\demo.db)

## migrate status (raw, run after the demo)

```
config:   write_mode=new read_mode=joined
expanded: true
orders:   8716 total, 0 not yet mapped
customers: 792
phase expand              done (2026-10-27T22:40:54.013Z → 2026-10-27T22:40:54.017Z)
phase backfill            done (2026-10-27T22:40:54.157Z → 2026-10-27T22:40:54.451Z)
phase verify              done (2026-10-27T22:40:58.823Z → 2026-10-27T22:40:58.828Z)
phase contract            done (2026-10-27T22:40:58.902Z → 2026-10-27T22:40:58.917Z)
last verify: PASS at 2026-10-27T22:40:58.828Z
```
