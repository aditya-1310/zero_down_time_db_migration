# Zero-downtime migration demo report

- generated: 2026-10-27T23:39:40.747Z
- mode: normal
- db: D:\zero_dt\data\demo.db · seed: 25,000 orders · api: http://127.0.0.1:3123
- elapsed wall time: 10.3s

## MIGRATION RESULT: SUCCESS

Zero-downtime assertion holds: **0 failed requests out of 21,982 (0.00%)** across the full expand → contract run under continuous live traffic.

## Timeline

| phase | started (UTC) | duration | requests during phase | failures during phase |
|---|---|---|---|---|
| expand | 2026-10-27T23:39:32.772Z | 227 ms | 400 | 0 |
| enable-dual | 2026-10-27T23:39:33.000Z | 92 ms | 167 | 0 |
| backfill | 2026-10-27T23:39:33.092Z | 1446 ms | 1,796 | 0 |
| verify | 2026-10-27T23:39:34.538Z | 162 ms | 339 | 0 |
| switch-reads | 2026-10-27T23:39:34.701Z | 96 ms | 180 | 0 |
| soak-v2-reads | 2026-10-27T23:39:34.801Z | 4001 ms | 10,512 | 0 |
| stop-legacy-writes | 2026-10-27T23:39:38.802Z | 86 ms | 167 | 0 |
| verify-post-cutover | 2026-10-27T23:39:38.888Z | 106 ms | 185 | 0 |
| contract | 2026-10-27T23:39:38.994Z | 153 ms | 215 | 0 |

Notable events:
- 2026-10-27T23:39:30.651Z — server-stdout: orders api listening on :3123 (db: D:\zero_dt\data\demo.db)
- 2026-10-27T23:39:30.766Z — server healthy (GET /health -> 200)
- 2026-10-27T23:39:30.769Z — load started (concurrency=4, writeRatio=0.3)
- 2026-10-27T23:39:32.771Z — warmup done (4122 requests, 0 failures)
- 2026-10-27T23:39:32.772Z — phase expand ok (227ms, 400 requests, 0 failures)
- 2026-10-27T23:39:33.000Z — phase enable-dual ok (92ms, 167 requests, 0 failures)
- 2026-10-27T23:39:33.092Z — phase backfill ok (1446ms, 1796 requests, 0 failures)
- 2026-10-27T23:39:34.538Z — phase verify ok (162ms, 339 requests, 0 failures)
- 2026-10-27T23:39:34.701Z — phase switch-reads ok (96ms, 180 requests, 0 failures)
- 2026-10-27T23:39:34.801Z — spot check: read_mode=joined, 5 orders
- 2026-10-27T23:39:34.801Z — phase soak-v2-reads ok (4001ms, 10512 requests, 0 failures)
- 2026-10-27T23:39:38.802Z — phase stop-legacy-writes ok (86ms, 167 requests, 0 failures)
- 2026-10-27T23:39:38.888Z — phase verify-post-cutover ok (106ms, 185 requests, 0 failures)
- 2026-10-27T23:39:38.994Z — phase contract ok (153ms, 215 requests, 0 failures)
- 2026-10-27T23:39:40.649Z — load stopped (21,982 total, 0 failures)
- 2026-10-27T23:39:40.667Z — server stopped (SIGTERM)

Read-cutover spot check (2026-10-27T23:39:34.801Z): `GET /orders?limit=5` → read_mode=**joined**, 5 orders returned.

## Latency (p50 / p95 / p99 / max, ms — nearest-rank over raw per-request samples)

| window | samples | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| overall (whole run) | 21,982 | 1 | 3 | 7 | 61 |
| backfill phase window | 1,796 | 2 | 16 | 35 | 61 |
| contract phase window | 215 | 2 | 7 | 39 | 40 |

## Totals

- load generator: 21,982 requests · 21,982 ok · 0 fail · error rate 0.00%
- load run duration: 9.9s
- warmup (2s before first phase): 4,122 requests, 0 failures
- server-side cross-check: 21,985 requests served, 0 rejected/errored
- database at end: 31,599 orders · 2,403 customers · write_mode=new · read_mode=joined
- elapsed wall time: 10.3s

## Operator CLI output per phase

### expand — 2026-10-27T23:39:32.772Z · 227 ms · exit 0

```
expand: customers table + orders.customer_id added (additive, no locks held on live rows)
```

### enable-dual — 2026-10-27T23:39:33.000Z · 92 ms · exit 0

```
enable-dual: app now writes legacy columns AND customer_id in one txn (rollback: migrate rollback-dual)
```

### backfill — 2026-10-27T23:39:33.092Z · 1446 ms · exit 0

```
backfill: starting (batch_size=1000, throttle_ms=15)
backfill: batch 1: 1000 rows scanned (1000 mapped)
backfill: batch 2: 1000 rows scanned (2000 mapped)
backfill: batch 3: 1000 rows scanned (3000 mapped)
backfill: batch 4: 1000 rows scanned (4000 mapped)
backfill: batch 5: 1000 rows scanned (5000 mapped)
backfill: batch 6: 1000 rows scanned (6000 mapped)
backfill: batch 7: 1000 rows scanned (7000 mapped)
backfill: batch 8: 1000 rows scanned (8000 mapped)
backfill: batch 9: 1000 rows scanned (9000 mapped)
backfill: batch 10: 1000 rows scanned (10000 mapped)
backfill: batch 11: 1000 rows scanned (11000 mapped)
backfill: batch 12: 1000 rows scanned (12000 mapped)
backfill: batch 13: 1000 rows scanned (13000 mapped)
backfill: batch 14: 1000 rows scanned (14000 mapped)
backfill: batch 15: 1000 rows scanned (15000 mapped)
backfill: batch 16: 1000 rows scanned (16000 mapped)
backfill: batch 17: 1000 rows scanned (17000 mapped)
backfill: batch 18: 1000 rows scanned (18000 mapped)
backfill: batch 19: 1000 rows scanned (19000 mapped)
backfill: batch 20: 1000 rows scanned (20000 mapped)
backfill: batch 21: 1000 rows scanned (21000 mapped)
backfill: batch 22: 1000 rows scanned (22000 mapped)
backfill: batch 23: 1000 rows scanned (23000 mapped)
backfill: batch 24: 1000 rows scanned (24000 mapped)
backfill: batch 25: 1000 rows scanned (25000 mapped)
backfill: batch 26: 1000 rows scanned (26000 mapped)
backfill: batch 27: 419 rows scanned (26419 mapped)
backfill: done — 26419 rows mapped, 2311 customers created in 27 batches (1335ms)
```

### verify — 2026-10-27T23:39:34.538Z · 162 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 27043 orders, 2403 customers, 0 unmapped
verify: all checks passed
```

### switch-reads — 2026-10-27T23:39:34.701Z · 96 ms · exit 0

```
switch-reads: reads now JOIN customers (rollback: migrate rollback-reads)
```

### soak-v2-reads — 2026-10-27T23:39:34.801Z · 4001 ms · exit 0

```
soaking live traffic on joined reads for 4000ms (no CLI action)
```

### stop-legacy-writes — 2026-10-27T23:39:38.802Z · 86 ms · exit 0

```
stop-legacy-writes: app no longer writes customer_name/customer_email
```

### verify-post-cutover — 2026-10-27T23:39:38.888Z · 106 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 30365 orders, 2403 customers, 0 unmapped
verify: all checks passed
```

### contract — 2026-10-27T23:39:38.994Z · 153 ms · exit 0

```
contract: legacy columns dropped. Migration complete.
```

## Server output (captured from the API child process)

- [server-stdout] orders api listening on :3123 (db: D:\zero_dt\data\demo.db)

## migrate status (raw, run after the demo)

```
config:   write_mode=new read_mode=joined
expanded: true
orders:   31599 total, 0 not yet mapped
customers: 2403
phase expand              done (2026-10-27T23:39:32.965Z → 2026-10-27T23:39:32.992Z)
phase backfill            done (2026-10-27T23:39:33.162Z → 2026-10-27T23:39:34.521Z)
phase verify              done (2026-10-27T23:39:38.971Z → 2026-10-27T23:39:38.991Z)
phase contract            done (2026-10-27T23:39:39.072Z → 2026-10-27T23:39:39.125Z)
last verify: PASS at 2026-10-27T23:39:38.991Z
```
