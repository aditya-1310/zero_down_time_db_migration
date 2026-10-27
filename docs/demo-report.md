# Zero-downtime migration demo report

- generated: 2026-10-27T22:55:09.267Z
- mode: normal
- db: D:\zero_dt\data\demo.db · seed: 25,000 orders · api: http://127.0.0.1:3123
- elapsed wall time: 10.1s

## MIGRATION RESULT: SUCCESS

Zero-downtime assertion holds: **0 failed requests out of 19,735 (0.00%)** across the full expand → contract run under continuous live traffic.

## Timeline

| phase | started (UTC) | duration | requests during phase | failures during phase |
|---|---|---|---|---|
| expand | 2026-10-27T22:55:01.524Z | 98 ms | 196 | 0 |
| enable-dual | 2026-10-27T22:55:01.623Z | 115 ms | 255 | 0 |
| backfill | 2026-10-27T22:55:01.738Z | 1283 ms | 1,712 | 0 |
| verify | 2026-10-27T22:55:03.021Z | 113 ms | 221 | 0 |
| switch-reads | 2026-10-27T22:55:03.134Z | 71 ms | 112 | 0 |
| soak-v2-reads | 2026-10-27T22:55:03.214Z | 4000 ms | 8,463 | 0 |
| stop-legacy-writes | 2026-10-27T22:55:07.214Z | 71 ms | 113 | 0 |
| verify-post-cutover | 2026-10-27T22:55:07.285Z | 175 ms | 286 | 0 |
| contract | 2026-10-27T22:55:07.460Z | 204 ms | 207 | 0 |

Notable events:
- 2026-10-27T22:54:59.382Z — server-stdout: orders api listening on :3123 (db: D:\zero_dt\data\demo.db)
- 2026-10-27T22:54:59.520Z — server healthy (GET /health -> 200)
- 2026-10-27T22:54:59.522Z — load started (concurrency=4, writeRatio=0.3)
- 2026-10-27T22:55:01.523Z — warmup done (5002 requests, 0 failures)
- 2026-10-27T22:55:01.524Z — phase expand ok (98ms, 196 requests, 0 failures)
- 2026-10-27T22:55:01.623Z — phase enable-dual ok (115ms, 255 requests, 0 failures)
- 2026-10-27T22:55:01.738Z — phase backfill ok (1283ms, 1712 requests, 0 failures)
- 2026-10-27T22:55:03.021Z — phase verify ok (113ms, 221 requests, 0 failures)
- 2026-10-27T22:55:03.134Z — phase switch-reads ok (71ms, 112 requests, 0 failures)
- 2026-10-27T22:55:03.214Z — spot check: read_mode=joined, 5 orders
- 2026-10-27T22:55:03.214Z — phase soak-v2-reads ok (4000ms, 8463 requests, 0 failures)
- 2026-10-27T22:55:07.214Z — phase stop-legacy-writes ok (71ms, 113 requests, 0 failures)
- 2026-10-27T22:55:07.285Z — phase verify-post-cutover ok (175ms, 286 requests, 0 failures)
- 2026-10-27T22:55:07.460Z — phase contract ok (204ms, 207 requests, 0 failures)
- 2026-10-27T22:55:09.166Z — load stopped (19,735 total, 0 failures)
- 2026-10-27T22:55:09.185Z — server stopped (SIGTERM)

Read-cutover spot check (2026-10-27T22:55:03.214Z): `GET /orders?limit=5` → read_mode=**joined**, 5 orders returned.

## Latency (p50 / p95 / p99 / max, ms — nearest-rank over raw per-request samples)

| window | samples | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| overall (whole run) | 19,735 | 2 | 3 | 7 | 44 |
| backfill phase window | 1,712 | 2 | 16 | 28 | 44 |
| contract phase window | 207 | 2 | 28 | 35 | 35 |

## Totals

- load generator: 19,735 requests · 19,735 ok · 0 fail · error rate 0.00%
- load run duration: 9.6s
- warmup (2s before first phase): 5,002 requests, 0 failures
- server-side cross-check: 19,738 requests served, 0 rejected/errored
- database at end: 30,847 orders · 2,440 customers · write_mode=new · read_mode=joined
- elapsed wall time: 10.1s

## Operator CLI output per phase

### expand — 2026-10-27T22:55:01.524Z · 98 ms · exit 0

```
expand: customers table + orders.customer_id added (additive, no locks held on live rows)
```

### enable-dual — 2026-10-27T22:55:01.623Z · 115 ms · exit 0

```
enable-dual: app now writes legacy columns AND customer_id in one txn (rollback: migrate rollback-dual)
```

### backfill — 2026-10-27T22:55:01.738Z · 1283 ms · exit 0

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
backfill: batch 27: 655 rows scanned (26655 mapped)
backfill: done — 26655 rows mapped, 2380 customers created in 27 batches (1195ms)
```

### verify — 2026-10-27T22:55:03.021Z · 113 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 27193 orders, 2440 customers, 0 unmapped
verify: all checks passed
```

### switch-reads — 2026-10-27T22:55:03.134Z · 71 ms · exit 0

```
switch-reads: reads now JOIN customers (rollback: migrate rollback-reads)
```

### soak-v2-reads — 2026-10-27T22:55:03.214Z · 4000 ms · exit 0

```
soaking live traffic on joined reads for 4000ms (no CLI action)
```

### stop-legacy-writes — 2026-10-27T22:55:07.214Z · 71 ms · exit 0

```
stop-legacy-writes: app no longer writes customer_name/customer_email
```

### verify-post-cutover — 2026-10-27T22:55:07.285Z · 175 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 29791 orders, 2440 customers, 0 unmapped
verify: all checks passed
```

### contract — 2026-10-27T22:55:07.460Z · 204 ms · exit 0

```
contract: legacy columns dropped. Migration complete.
```

## Server output (captured from the API child process)

- [server-stdout] orders api listening on :3123 (db: D:\zero_dt\data\demo.db)

## migrate status (raw, run after the demo)

```
config:   write_mode=new read_mode=joined
expanded: true
orders:   30847 total, 0 not yet mapped
customers: 2440
phase expand              done (2026-10-27T22:55:01.607Z → 2026-10-27T22:55:01.617Z)
phase backfill            done (2026-10-27T22:55:01.823Z → 2026-10-27T22:55:03.024Z)
phase verify              done (2026-10-27T22:55:07.352Z → 2026-10-27T22:55:07.394Z)
phase contract            done (2026-10-27T22:55:07.539Z → 2026-10-27T22:55:07.660Z)
last verify: PASS at 2026-10-27T22:55:07.394Z
```
