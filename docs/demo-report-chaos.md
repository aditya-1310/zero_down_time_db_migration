# Zero-downtime migration demo report

- generated: 2026-10-27T22:55:58.200Z
- mode: chaos (first backfill run killed with SIGKILL mid-run)
- db: D:\zero_dt\data\demo.db · seed: 25,000 orders · api: http://127.0.0.1:3123
- elapsed wall time: 10.8s

## MIGRATION RESULT: SUCCESS

Zero-downtime assertion holds: **0 failed requests out of 21,180 (0.00%)** across the full expand → contract run under continuous live traffic.

## Timeline

| phase | started (UTC) | duration | requests during phase | failures during phase |
|---|---|---|---|---|
| expand | 2026-10-27T22:55:49.778Z | 143 ms | 301 | 0 |
| enable-dual | 2026-10-27T22:55:49.922Z | 79 ms | 139 | 0 |
| backfill | 2026-10-27T22:55:50.628Z | 1398 ms | 2,063 | 0 |
| verify | 2026-10-27T22:55:52.027Z | 126 ms | 239 | 0 |
| switch-reads | 2026-10-27T22:55:52.153Z | 80 ms | 134 | 0 |
| soak-v2-reads | 2026-10-27T22:55:52.240Z | 4000 ms | 8,480 | 0 |
| stop-legacy-writes | 2026-10-27T22:55:56.240Z | 102 ms | 188 | 0 |
| verify-post-cutover | 2026-10-27T22:55:56.342Z | 144 ms | 266 | 0 |
| contract | 2026-10-27T22:55:56.487Z | 123 ms | 146 | 0 |

Notable events:
- 2026-10-27T22:55:47.631Z — server-stdout: orders api listening on :3123 (db: D:\zero_dt\data\demo.db)
- 2026-10-27T22:55:47.774Z — server healthy (GET /health -> 200)
- 2026-10-27T22:55:47.778Z — load started (concurrency=4, writeRatio=0.3)
- 2026-10-27T22:55:49.778Z — warmup done (5025 requests, 0 failures)
- 2026-10-27T22:55:49.778Z — phase expand ok (143ms, 301 requests, 0 failures)
- 2026-10-27T22:55:49.922Z — phase enable-dual ok (79ms, 139 requests, 0 failures)
- 2026-10-27T22:55:50.627Z — backfill-killed — first backfill run killed with SIGKILL after ~600ms (exit code null, signal SIGKILL); rows completed before the kill are unknown by design
- 2026-10-27T22:55:50.628Z — phase backfill ok (1398ms, 2063 requests, 0 failures)
- 2026-10-27T22:55:52.027Z — phase verify ok (126ms, 239 requests, 0 failures)
- 2026-10-27T22:55:52.153Z — phase switch-reads ok (80ms, 134 requests, 0 failures)
- 2026-10-27T22:55:52.240Z — spot check: read_mode=joined, 5 orders
- 2026-10-27T22:55:52.240Z — phase soak-v2-reads ok (4000ms, 8480 requests, 0 failures)
- 2026-10-27T22:55:56.240Z — phase stop-legacy-writes ok (102ms, 188 requests, 0 failures)
- 2026-10-27T22:55:56.342Z — phase verify-post-cutover ok (144ms, 266 requests, 0 failures)
- 2026-10-27T22:55:56.487Z — phase contract ok (123ms, 146 requests, 0 failures)
- 2026-10-27T22:55:58.112Z — load stopped (21,180 total, 0 failures)
- 2026-10-27T22:55:58.129Z — server stopped (SIGTERM)

Read-cutover spot check (2026-10-27T22:55:52.240Z): `GET /orders?limit=5` → read_mode=**joined**, 5 orders returned.

## Latency (p50 / p95 / p99 / max, ms — nearest-rank over raw per-request samples)

| window | samples | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| overall (whole run) | 21,180 | 2 | 3 | 8 | 39 |
| backfill phase window | 2,063 | 2 | 14 | 19 | 39 |
| contract phase window | 146 | 2 | 11 | 36 | 36 |

## Totals

- load generator: 21,180 requests · 21,180 ok · 0 fail · error rate 0.00%
- load run duration: 10.3s
- warmup (2s before first phase): 5,025 requests, 0 failures
- server-side cross-check: 21,183 requests served, 0 rejected/errored
- database at end: 31,369 orders · 2,475 customers · write_mode=new · read_mode=joined
- elapsed wall time: 10.8s

## Chaos: backfill killed mid-run

- 2026-10-27T22:55:50.627Z: spawned `migrate backfill` slowed to `--batch-size 100 --throttle-ms 25` (so the kill reliably lands mid-run), then SIGKILLed it after ~600ms (exit code null, signal SIGKILL).
- rows completed by the killed run are unknown by design — it kept no cursor outside the data; the rerun must resume via `customer_id IS NULL`.
- the rerun (normal phase, default batching) completed under the same live traffic:

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
backfill: batch 26: 557 rows scanned (25557 mapped)
backfill: done — 25557 rows mapped, 1893 customers created in 26 batches (1280ms)
```

## Operator CLI output per phase

### expand — 2026-10-27T22:55:49.778Z · 143 ms · exit 0

```
expand: customers table + orders.customer_id added (additive, no locks held on live rows)
```

### enable-dual — 2026-10-27T22:55:49.922Z · 79 ms · exit 0

```
enable-dual: app now writes legacy columns AND customer_id in one txn (rollback: migrate rollback-dual)
```

### backfill — 2026-10-27T22:55:50.628Z · 1398 ms · exit 0

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
backfill: batch 26: 557 rows scanned (25557 mapped)
backfill: done — 25557 rows mapped, 1893 customers created in 26 batches (1280ms)
```

### verify — 2026-10-27T22:55:52.027Z · 126 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 27668 orders, 2475 customers, 0 unmapped
verify: all checks passed
```

### switch-reads — 2026-10-27T22:55:52.153Z · 80 ms · exit 0

```
switch-reads: reads now JOIN customers (rollback: migrate rollback-reads)
```

### soak-v2-reads — 2026-10-27T22:55:52.240Z · 4000 ms · exit 0

```
soaking live traffic on joined reads for 4000ms (no CLI action)
```

### stop-legacy-writes — 2026-10-27T22:55:56.240Z · 102 ms · exit 0

```
stop-legacy-writes: app no longer writes customer_name/customer_email
```

### verify-post-cutover — 2026-10-27T22:55:56.342Z · 144 ms · exit 0

```
PASS  no_unmapped_orders — expected 0 orders with customer_id IS NULL, got 0
  PASS  no_orphan_orders — expected 0 orders pointing at a missing customer, got 0
  PASS  email_mapping_intact — expected 0 joined rows where lower(trim(legacy email)) != customers.email, got 0
  PASS  no_duplicate_customers — expected customers.email has no duplicates (UNIQUE enforced, belt and braces), got 0
  PASS  no_invalid_customers — expected 0 customers with an invalid email shape or empty name (poison-row guard), got 0
  counts: 30349 orders, 2475 customers, 0 unmapped
verify: all checks passed
```

### contract — 2026-10-27T22:55:56.487Z · 123 ms · exit 0

```
contract: legacy columns dropped. Migration complete.
```

## Server output (captured from the API child process)

- [server-stdout] orders api listening on :3123 (db: D:\zero_dt\data\demo.db)

## migrate status (raw, run after the demo)

```
config:   write_mode=new read_mode=joined
expanded: true
orders:   31369 total, 0 not yet mapped
customers: 2475
phase expand              done (2026-10-27T22:55:49.883Z → 2026-10-27T22:55:49.910Z)
phase backfill            done (2026-10-27T22:55:50.716Z → 2026-10-27T22:55:52.016Z)
phase verify              done (2026-10-27T22:55:56.398Z → 2026-10-27T22:55:56.441Z)
phase contract            done (2026-10-27T22:55:56.541Z → 2026-10-27T22:55:56.590Z)
last verify: PASS at 2026-10-27T22:55:56.441Z
```
