# Runbook — Zero-downtime migration: orders → customers

**Scenario:** normalize `orders.customer_name` / `orders.customer_email` into a
`customers` table while the orders API serves live traffic.
**Outcome:** zero failed requests, no restarts, no maintenance window.
**Design:** [EDD](edd.md) · **Real-run report:** [demo-report.md](demo-report.md) ·
**What actually happened:** [post-mortem](postmortem.md)

## 0. Preconditions (all must be true before phase 1)

| # | Check | Command |
|---|-------|---------|
| 0.1 | API healthy, traffic flowing | `curl -s localhost:3100/health` → `{"ok":true,...}` |
| 0.2 | Tests green on the release commit | `npm test` |
| 0.3 | **Pre-migration backup taken** | `cp data/app.db backup-premigration.db` (SQLite: copy file after a checkpoint; Postgres: `pg_dump`) |
| 0.4 | Operator has the CLI | `npm run migrate -- status` → prints config, nothing expanded |
| 0.5 | Baseline error rate is 0% | watch the load generator / dashboards |

**Abort criteria (any phase):** error rate > 0% that is not explainable, or a
verify check that fails twice after investigation. Roll back the current phase
(rollback column below), fix, resume. Phases are idempotent — rerunning is safe.

## Phase table (command → gate → rollback)

| Phase | Command | Gate to proceed | Rollback |
|-------|---------|-----------------|----------|
| 1. Expand | `npm run migrate -- expand` | output says added; `status` shows `expanded: true` | drop the new column + customers table |
| 2. Dual-write on | `npm run migrate -- enable-dual` | `GET /health` shows `write_mode: dual`; spot-check a POST returns a `customer_id` | `npm run migrate -- rollback-dual` (CLI refuses once reads are joined — roll reads back first) |
| 3. Backfill | `npm run migrate -- backfill` | finishes with `0 unmapped`; **rerun it** — second run maps 0 rows (idempotency proof) | none needed — rerun resumes |
| 4. Verify | `npm run migrate -- verify` | exit 0, all checks PASS | n/a (read-only) |
| 5. Cut reads over | `npm run migrate -- switch-reads` | `GET /orders` shows `read_mode: joined`; `write_mode` must not be `legacy` (CLI enforces — joined reads hide rows written without `customer_id`); soak ≥ 5 min (demo: 4 s) | `npm run migrate -- rollback-reads` |
| 6. Stop legacy writes | `npm run migrate -- stop-legacy-writes` | `write_mode: new`; POSTs still 201; watch error rate | set `write_mode=dual` (partial: rows since cutover have NULL legacy cols — joined reads unaffected) |
| 7. Contract | `npm run migrate -- contract --yes` | **point of no return** — only after checklist §7 | restore from the phase-0 backup |

## 1. Expand — add the new shapes (additive only)

```
npm run migrate -- expand
```

Creates `customers`, adds nullable `orders.customer_id` + index. Legacy columns
must be nullable by now (fresh DBs here already are; on Postgres this phase is
where you run `ALTER TABLE orders ALTER COLUMN customer_name DROP NOT NULL`).
No existing row is touched; traffic never notices.

**Expected:** `expand: customers table + orders.customer_id added`
**Watch for:** DDL taking longer than a second → stop, investigate locks before
continuing (Postgres: `lock_timeout`, `CREATE INDEX CONCURRENTLY` instead).

## 2. Enable dual-write — app writes both shapes in one txn

```
npm run migrate -- enable-dual
```

New writes now: upsert `customers` by normalized email + insert order with
legacy columns **and** `customer_id`. After this moment the unmapped-row count
can only shrink.

**Expected:** `write_mode: dual` in `/health`; a POST returns `customer_id`.
**Watch for:** write latency p95 rising (extra upsert) — should be single-digit ms.

## 3. Backfill — map history in throttled batches

```
npm run migrate -- backfill            # default: batch 1000, 15ms sleep between batches
```

One transaction per batch; lock held only inside it. `customer_id IS NULL` is
the resume cursor — killed anywhere, it reruns and continues.

**Expected:** progress lines per batch, then `done — N rows mapped`.
**If it prints `WARNING — N rows skipped`:** legacy garbage (NULL/empty/malformed
email, NULL name). Those rows stay unmapped **on purpose** and verify will fail
until a human fixes the data (`SELECT * FROM orders WHERE customer_id IS NULL`
to see them). Do not `--force` past this.
**Tuning:** big table → raise `--batch-size`, keep `--throttle-ms` ≥ 10 so live
writes are never starved.

## 4. Verify — the cutover gate

```
npm run migrate -- verify
```

Five invariants: no unmapped orders, no orphan FKs, email mapping intact, no
duplicate customers, no invalid customers. Exit code 1 on any failure —
`switch-reads` and `contract` read this record and **will refuse** without a
passing verify.

## 5. Cut reads over — JOINed reads, reversible

```
npm run migrate -- switch-reads
```

**Expected:** `GET /orders` returns `read_mode: "joined"`, same order data,
emails now normalized. Soak (real systems: hours–days; demo: seconds) watching
error rate + latency. Anything smells → `rollback-reads` (legacy columns were
still being maintained — that's why this is reversible).

## 6. Stop legacy writes — app stops populating old columns

```
npm run migrate -- stop-legacy-writes
```

Gates: verify passed + reads already joined + legacy columns nullable. New rows
now have NULL legacy columns — joined reads are unaffected.

**Watch for:** POST error rate must stay 0. A spike means some path still writes
legacy columns — `rollback-dual` and fix before contract.

## 7. Contract — drop the old columns (POINT OF NO RETURN)

Checklist, all required:

- [ ] verify passed **after** step 6 (run `npm run migrate -- verify` again)
- [ ] error rate 0% for the whole soak on joined reads + new writes
- [ ] fresh backup taken now (`cp data/app.db backup-precontract.db`)
- [ ] rollback story accepted: from here, rollback = restore backup

```
npm run migrate -- contract --yes
```

Drops `customer_name`, `customer_email`. Brief write-lock; requests should see
latency, never errors (WAL + `busy_timeout`). `GET /orders` keeps working —
reads were already joined.

## 8. Chaos drill (prove resume before you need it)

```
npm run demo:chaos
```

SIGKILLs the backfill ~600 ms into its run, then reruns it under the same live
traffic. The report must show SUCCESS with the rerun completing from where the
killed run stopped. If the rerun duplicates customers or loses rows — stop
everything, the idempotency claim is broken.

## Postgres translation (what changes on a real database)

| This repo (SQLite) | PostgreSQL |
|---|---|
| `busy_timeout` + WAL | `lock_timeout = 2s`, `statement_timeout = 15s` on every migration txn |
| additive ALTERs (fast) | same, plus `CREATE INDEX CONCURRENTLY` (can't run inside a txn) |
| nullable-from-birth legacy cols | `ALTER COLUMN … DROP NOT NULL` during expand |
| per-batch txn, keyset scan | same, or workers with `FOR UPDATE SKIP LOCKED` |
| `DROP COLUMN` (table rebuild, brief exclusive) | `DROP COLUMN` is metadata-only since PG 11 — near-instant; old table bloat reclaimed later via `VACUUM FULL`/rewrite tooling |

## One-command versions

Full automated run (this is what CI / the README demo does):
`npm run demo` · with the chaos drill: `npm run demo:chaos`
