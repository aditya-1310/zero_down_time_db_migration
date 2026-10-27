# debugging notes — the actual bugs I hit building this

no polish, no corporate format. this is just every real issue I ran into while
building the migration tool, in the order I hit them, written the way I'd explain
it to a friend. if you're interviewing me and ask "what went wrong", these are
the honest answers.

---

## 1. every single POST was failing and it was one stupid parameter

the very first version of the API had this:

```js
function insertOrder(db, mode, body) { ... }
// ...
const created = insertOrder(db, body);   // mode never passed, body landed in the wrong slot
```

so `body` went into `mode` and `body.customer_name` exploded with
"Cannot read properties of undefined". every write 500'd. the funny part is the
`mode` parameter didn't even make sense — the whole design reads the write mode
from the database inside the transaction, so the parameter had no reason to
exist. I removed it instead of "fixing" the call site.

**takeaway:** when a bug feels weird, check whether the thing you're passing
should exist at all before fixing how you pass it.

## 2. the big one — 69 failed requests in my first full run

this is the one I lead with in interviews. the first complete rehearsal of the
migration (with fake live traffic hammering the API the whole time) FAILED.
the moment `stop-legacy-writes` flipped the app over to the new write path,
every order insert started dying with:

```
NOT NULL constraint failed: orders.customer_name
```

69 failed requests before the run aborted. the reason: my original schema had
`customer_name` and `customer_email` as NOT NULL, which made total sense for the
old system — right up until the migration's whole job is to STOP writing those
columns. "the app stops filling in this column" is secretly a schema change, and
nothing in my tooling checked for it.

the fix I'm actually proud of: it's not "remember to relax the constraint".
the CLI now refuses to run `stop-legacy-writes` if the legacy columns are still
NOT NULL. the computer checks now, so future-me doesn't have to remember.

**takeaway:** a migration step whose precondition can be checked, should be
checked by the tool. runbook sentences don't stop outages at 2am.

## 3. garbage data almost merged strangers into one customer

while reviewing the backfill I realized legacy tables never look like the
sample data. mine had NULL emails, empty strings, emails with no `@`. and the
naive backfill handles those in the worst possible ways:

- a NULL email becomes `String(null)` → the literal string `"null"` → the
  backfill happily creates a customer with email "null" and merges every
  garbage order onto it
- a NULL name violates `customers.name NOT NULL` → the batch rolls back → the
  rerun hits the same row → the backfill is stuck FOREVER on one poison row

so I added validation: skip invalid rows, count them by reason, tell the
operator loudly. verify then fails on the leftover unmapped rows on purpose,
which keeps the cutover gates shut until a human deals with the data.

**and then I immediately made it worse.** my first version of the skip logic
left the bad rows with `customer_id IS NULL` — but the backfill finds work by
scanning `WHERE customer_id IS NULL`. skipped rows stay NULL. so the scanner
would pick the same poison rows again and again, forever. an infinite loop I
wrote myself, caught it while writing the test for the feature. the fix was
keyset pagination — each run walks ids in order (`AND id > last_id`), so
everything gets visited exactly once, and reruns across restarts still work
because ids only go up.

**takeaway:** the moment you skip rows, your "what's left" query and your skip
policy have to agree, or you've built a loop. also: never trust legacy data to
be shaped like your fixtures.

## 4. the invisible order — my favorite bug, and the scariest

this one survived all 17 tests and a full code review. I found it by attacking
my own finished project: what if an operator does the steps out of order?

the sequence: finish the backfill → panic, roll writes back to legacy
(`rollback-dual`) → run `verify` (passes! zero unmapped rows at that exact
moment!) → `switch-reads`. every gate was individually satisfied.

then a new order comes in. the API accepts it, the row is in the database... and
joined reads never show it. because the app was in legacy write mode, the row
had no `customer_id`, and joined reads do an INNER JOIN — rows without a
customer simply don't come back. a paying customer's order, written and
invisible.

the root cause is a subtle distinction I now think about constantly: verify
checks **history** ("the data was clean when I ran"), but the gates need
something that checks **the present** ("the world is still in the shape verify
assumed"). the fix was three things: `switch-reads` refuses when write mode is
still legacy, `rollback-dual` refuses once reads are already joined, and verify
runs all its counts inside one snapshot transaction so a write landing halfway
through can't produce numbers from two different moments.

**takeaway:** "it passed validation" and "it's safe right now" are different
questions. out-of-order operations are where migrations actually die.

## 5. the test harness itself lied — the orphan server

I killed the demo process with SIGKILL to test failure handling. cleanup
handlers don't run on SIGKILL, so the API server it had spawned survived as an
orphan, still holding the port. then I reran the demo and things got
interesting: the new server couldn't bind the port, every health check silently
hit the OLD orphan process (whose database file had been deleted out from under
it), and the run only fell over later at a spot check. honestly, the fact that
it fell over at all is because the spot check refuses to trust `read_mode` —
that check earned its keep.

the fix: the demo now probes the port before spawning anything and aborts with
"kill the orphan, then rerun". and my first version of THAT fix was wrong too —
I probed `127.0.0.1` specifically, but the orphan was bound to all interfaces,
so the probe passed straight past it. the probe now binds exactly the way the
real server does.

**takeaway:** test the failure of your test harness. the migration logic was
fine; the measurement layer was one kill -9 away from lying to me.

## 6. small ones that still cost me time

- **a failed demo left a stale report.** when a run aborted, I printed the
  error but never rewrote the report file — so after a failure,
  `demo-report.md` still showed the previous run's big green SUCCESS. a report
  that can silently lie is worse than no report. now an aborted run also writes
  a FAILURE report.
- **`node --test test/` doesn't work on my machine.** on Windows + the Node
  version I have, the test runner treats a bare directory as a module to
  execute and dies before running anything. had to use a glob
  (`--test "test/*"`). cost me a confusing hour of "why does CI-style
  invocation run zero tests".
- **verify after contract crashes with a raw SQL error.** dropping the columns
  means verify's queries reference columns that don't exist. it exits non-zero,
  which is safe, but the message is `no such column: o.customer_email` instead
  of "you already did this". on my list to make friendlier; I left it because
  failing loudly and safely was more important than failing politely.

---

if you ask me in an interview: I'd tell #2 first (it's the clearest story —
wrong schema assumption, caught by asserting zero errors under load), then #4
(the invisible order — because the lesson generalizes: gates must check the
present, not just history), then #3 if they want data-quality war stories.
#5 is the one I'd use if they ask about testing discipline, because the bug was
in my measuring stick, not my product.
