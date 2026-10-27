# Post-mortem — orders → customers zero-downtime migration

**Date:** 2026-10-28 · **Author:** Aditya (operator) · **Status:** published
**Scope:** the full expand→contract migration of ~25,000 seeded + live-written
orders to the normalized `customers` schema, plus the two incidents found on
the way to a clean run.

## TL;DR

The migration completed with **0 failed requests out of 19,735 (0.00%)** under
continuous live traffic, no restarts, no maintenance window. The backfill was
SIGKILLed mid-run in a chaos drill and resumed cleanly. It was not clean on the
first attempt: the initial rehearsal **failed with 69 HTTP 500s** during the
stop-legacy-writes step, and a design review found a second outage-class bug
(poison legacy rows) before it ever ran. Both are below, with the fixes that
are now gates in the tooling.

Final numbers (full report: [demo-report.md](demo-report.md)):

| Metric | Value |
|---|---|
| Requests served during migration window | 19,735 (server cross-check: 19,738) |
| Failed requests | **0** (0.00%) |
| p50 / p95 / p99 / max latency, whole run | 2 / 3 / 7 / 44 ms |
| p95 / p99 during backfill | 16 / 28 ms |
| p95 / p99 during contract (DROP COLUMN) | 28 / 35 ms |
| Backfill duration (25,000 rows, batch 1000, 15ms throttle) | 1.3 s |
| Orders / customers at end | 30,847 / 2,440 |

## Timeline (UTC, final run)

| Time | Event |
|---|---|
| 22:54:59 | API up, load generator started (concurrency 4, 30% writes) |
| 22:55:01 | warmup clean (5,002 req, 0 fail) — baseline error rate 0% |
| 22:55:01.5 | expand — customers + nullable customer_id added (98 ms) |
| 22:55:01.6 | enable-dual — writes now hit both shapes (115 ms) |
| 22:55:01.7 | backfill — 25,000 rows mapped in 1.3 s while serving 1,712 requests |
| 22:55:03.0 | verify — 5/5 invariants pass; cutover gates open |
| 22:55:03.1 | switch-reads — joined reads, spot-checked (5/5 orders, read_mode=joined) |
| 22:55:03–07 | soak on joined reads: 8,463 requests, 0 failures |
| 22:55:07.2 | stop-legacy-writes |
| 22:55:07.3 | verify #2 — still 5/5 after writes stopped |
| 22:55:07.5 | contract — legacy columns dropped (204 ms) |
| 22:55:09 | load stopped. 0 failures. Result: SUCCESS |

## Incident 1 — First rehearsal: 69 × HTTP 500 at stop-legacy-writes (outage-class, caught in rehearsal)

**What happened.** In the first automated rehearsal, the instant
`stop-legacy-writes` flipped `write_mode=new`, every POST failed with
`NOT NULL constraint failed: orders.customer_name` — 69 failures before the
run was aborted. Read traffic was unaffected; writes were down hard.

**Detection.** The demo's own success assertion — "all phases exit 0 AND the
load generator saw zero failed requests" — turned the run red and wrote a
FAILURE report. This is exactly the assertion working; without a load generator
asserting error rate, a manual smoke test of the CLI steps alone would have
looked green all the way into phase 6.

**Root cause.** The baseline schema declared the legacy columns `NOT NULL`.
Phase 6 means "inserts stop providing these columns" — combined with `NOT
NULL`, every insert is a constraint violation. The schema and the phase design
contradicted each other; the EDD's rollback note for phase 6 even implied NULL
legacy rows were possible, but nothing enforced the prerequisite.

**Fix (permanent, not procedural).**
1. Legacy columns are nullable from creation in this repo.
2. `stop-legacy-writes` now **refuses to run** if the legacy columns are still
   `NOT NULL` — the prerequisite became a hard gate in the CLI, not a runbook
   sentence a tired operator can skip. On PostgreSQL the equivalent is
   `ALTER COLUMN … DROP NOT NULL` during expand, which the runbook calls out.

**Lesson.** "The app stops writing column X" is a schema change, not just a
code-path change — its precondition (column nullable) must be verified by the
tooling, ideally as far upstream as the DDL phase that makes it true.

## Incident 2 — Poison legacy rows: the backfill that would have wedged or merged strangers (found in review, never shipped)

**What the bug was.** Two failure shapes hiding in the same naive backfill:
- `orders.customer_email` of `NULL`, `''`, or `'   '` normalizes to the strings
  `"null"` / `""` — the backfill would create a **customer with email `"null"`
  and attach every garbage order to it**, silently merging unrelated people.
- `orders.customer_name = NULL` violates `customers.name NOT NULL` → the batch
  transaction rolls back → the rerun hits the same row → **backfill permanently
  stuck**, and with it the whole migration.

**Why it matters more than it looks.** Verify as originally written *passed*
with these rows present (NULL comparisons drop out of the email-integrity
check), so the gates would have opened onto corrupted identity data. Silent
success is worse than failure here.

**Fix.** The backfill validates every row against the same email/name shape the
API enforces; invalid rows are skipped, counted, and reported by reason
(`invalid_email`, `invalid_name`). Skipped rows stay unmapped, so
`verify`'s `no_unmapped_orders` check fails on purpose and **holds the cutover
gates closed until a human fixes the data**. A new `no_invalid_customers`
verify check guards the customers side too. The scan became keyset-paginated
(`id > cursor`) because a pure `WHERE customer_id IS NULL` loop re-selects
skipped rows forever — noted because that exact infinite loop was introduced
and caught while writing the skip logic (regression test added).

**Lesson.** Any backfill over legacy data needs an explicit, tested policy for
rows that don't validate — and the policy should fail loudly, not repair
silently. Migration tooling earns trust by stopping, not by improvising.

## What went well

- **Zero-downtime held through the destructive step.** Contract (DROP COLUMN)
  was the latency peak (p95 28 ms vs 3 ms steady-state) and caused **zero
  errors** — WAL + `busy_timeout` turned a lock into a wait, which is the whole
  design in one sentence.
- **The gates did their job.** During development, out-of-order invocations
  (switch-reads before verify, contract before stop-legacy-writes, backfill
  before dual-write) were refused by the CLI, not by operator memory.
- **Chaos drill passed.** SIGKILL 600 ms into the backfill; the rerun resumed
  from the data itself (no external cursor) and finished with 0 duplicates —
  [demo-report-chaos.md](demo-report-chaos.md).
- **Dual verification.** Load generator (client view) and server counters
  (server view) agreed: 19,735 vs 19,738 requests, both 0 errors.

## What we'd do differently

1. **Soak longer than seconds.** The demo soaks joined reads for 4 s because
   it's a demo. In production the read cutover deserves hours or days of
   shadow-traffic comparison before legacy writes stop; the runbook says so,
   the tooling should allow it just as cheaply.
2. **Backfill progress observability.** Rows/sec and ETA are derivable from the
   batch logs but not surfaced; on a 500M-row table you live in that dashboard.
   (Postgres: the same loop over `SELECT … FOR UPDATE SKIP LOCKED` workers.)
3. **Checksum-based verification for very large tables.** Count/join checks are
   exact but O(table); a per-batch checksum during backfill would scale better.
4. **The '69 failures' number came from a rehearsal that was allowed to fail.**
   Keep it that way: automated rehearsal with a hard 0% error assertion is the
   cheapest insurance in this entire document.

## Artifacts

- Design: [edd.md](edd.md) · Runbook followed: [runbook.md](runbook.md)
- Normal run: [demo-report.md](demo-report.md) · Chaos run: [demo-report-chaos.md](demo-report-chaos.md)
- Tests: `npm test` — 17 tests covering backfill idempotency/resume/poison
  rows, API mode behavior, verify gating, loadgen honesty, and a full in-process
  e2e migration under concurrent writes.
