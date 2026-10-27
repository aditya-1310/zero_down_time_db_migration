#!/usr/bin/env node
// Demo orchestrator: run a FULL expand→contract migration under live traffic
// and report. Success = every operator phase exits 0 AND the load generator saw
// zero failed requests across the whole run (the zero-downtime assertion).
// `--chaos` SIGKILLs the first backfill run mid-flight to prove the rerun
// resumes instead of duplicating or losing work.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createBaselineSchema, seedOrders } from '../src/schema.js';
import { LoadGenerator, percentile } from '../src/loadgen.js';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.join(ROOT, 'docs', 'demo-report.md');

const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const chaos = argv.includes('--chaos');
const seedCount = parseInt(argValue('--seed-count', '25000'), 10);
const port = parseInt(argValue('--port', '3123'), 10);
const dbPath = path.resolve(ROOT, argValue('--db', 'data/demo.db'));
const baseUrl = `http://127.0.0.1:${port}`;

const childEnv = { ...process.env, DB_PATH: dbPath, PORT: String(port) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const fmt = (n) => n.toLocaleString('en-US');
const indent = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');

const children = new Set();
const serverLines = [];
const timeline = [];
const phases = [];
let server = null;
let serverStopped = false;
let load = null;
let finalSnapshot = null;
let warmupSnapshot = null;
let apiStats = null;
let statusOutput = '';
let spotCheckResult = null;
let chaosKill = null;
let aborted = null;
const runStartedAt = Date.now();

// Never leak a child process, even on Ctrl-C.
process.on('SIGINT', () => {
  console.error('\ndemo: SIGINT — killing child processes');
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
  process.exit(130);
});

function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function collectLines(stream, tag) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trimEnd();
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        serverLines.push({ tag, text: line });
        timeline.push({ at: nowIso(), event: `${tag}: ${line}` });
      }
    }
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function waitForHealth(maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) {
        timeline.push({ at: nowIso(), event: 'server healthy (GET /health -> 200)' });
        return;
      }
    } catch {}
    await sleep(150);
  }
  const captured = serverLines.map((l) => `[${l.tag}] ${l.text}`).join('\n') || '(no output captured)';
  throw new Error(`server never became healthy on ${baseUrl} within ${maxMs}ms — server output:\n${captured}`);
}

async function stopServer() {
  if (serverStopped || !server) return;
  serverStopped = true;
  try {
    server.kill(); // SIGTERM semantics; on Windows terminates the process
  } catch {}
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  timeline.push({ at: nowIso(), event: 'server stopped (SIGTERM)' });
}

async function cli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--no-warnings', 'src/migrate.js', ...args],
      { env: childEnv, cwd: ROOT, encoding: 'utf8' }
    );
    return [stdout, stderr].filter((s) => s && s.trim()).join('\n').trimEnd();
  } catch (err) {
    const output = [err.stdout, err.stderr].filter((s) => s && s.trim()).join('\n').trimEnd() || '(no output)';
    const wrapped = new Error(`migrate ${args.join(' ')} exited non-zero (code ${err.code})\n${output}`);
    wrapped.output = output;
    wrapped.code = err.code;
    throw wrapped;
  }
}

// Cumulative snapshots are append-only, so a delta is subtraction on counters
// and a suffix slice on the latency array.
function delta(before, after) {
  const failByType = {};
  for (const [type, count] of Object.entries(after.failByType)) {
    const d = count - (before.failByType[type] ?? 0);
    if (d > 0) failByType[type] = d;
  }
  return {
    total: after.total - before.total,
    ok: after.ok - before.ok,
    fail: after.fail - before.fail,
    failByType,
    latenciesMs: after.latenciesMs.slice(before.latenciesMs.length),
  };
}

async function runPhase(name, fn) {
  console.log(`\n=== phase: ${name} ===`);
  const before = load.snapshot();
  const t0 = Date.now();
  const startIso = nowIso();
  let cliOutput = '';
  let exitCode = 0;
  try {
    cliOutput = String(await fn());
  } catch (err) {
    exitCode = Number.isInteger(err.code) ? err.code : 1;
    cliOutput = String(err.output ?? err.message ?? err);
    phases.push({
      name,
      startIso,
      endIso: nowIso(),
      durationMs: Date.now() - t0,
      loadDelta: delta(before, load.snapshot()),
      cliOutput,
      exitCode,
    });
    throw err;
  }
  const phase = {
    name,
    startIso,
    endIso: nowIso(),
    durationMs: Date.now() - t0,
    loadDelta: delta(before, load.snapshot()),
    cliOutput,
    exitCode,
  };
  phases.push(phase);
  timeline.push({
    at: startIso,
    event: `phase ${name} ok (${phase.durationMs}ms, ${phase.loadDelta.total} requests, ${phase.loadDelta.fail} failures)`,
  });
  const out = cliOutput.trim();
  if (out) console.log(indent(out));
  console.log(
    `    — ${fmt(phase.loadDelta.total)} requests during phase, ${phase.loadDelta.fail} failures, ${phase.durationMs}ms`
  );
  return phase;
}

async function spotCheck() {
  console.log(`\n=== spot check: reads cut over ===`);
  const body = await fetchJson(`${baseUrl}/orders?limit=5`);
  spotCheckResult = { at: nowIso(), read_mode: body.read_mode, orders_returned: body.orders?.length ?? 0 };
  console.log(
    `    GET /orders?limit=5 -> read_mode=${spotCheckResult.read_mode}, ${spotCheckResult.orders_returned} orders`
  );
  timeline.push({
    at: spotCheckResult.at,
    event: `spot check: read_mode=${spotCheckResult.read_mode}, ${spotCheckResult.orders_returned} orders`,
  });
  if (spotCheckResult.read_mode !== 'joined') {
    throw new Error(`ABORT: read_mode is '${spotCheckResult.read_mode}' after switch-reads — expected 'joined'`);
  }
  if (spotCheckResult.orders_returned !== 5) {
    console.log(`    note: expected 5 orders back, got ${spotCheckResult.orders_returned}`);
  }
}

// Chaos step: kill the first backfill run mid-flight, then let the normal
// phase rerun prove it resumes via `customer_id IS NULL`. The killed run is
// slowed down (small batches + throttle) so the kill reliably lands mid-run.
async function chaosKillBackfill() {
  console.log(`\n=== chaos: kill the backfill mid-run ===`);
  const child = track(
    spawn(
      process.execPath,
      ['--no-warnings', 'src/migrate.js', 'backfill', '--batch-size', '100', '--throttle-ms', '25'],
      { env: childEnv, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  );
  let output = '';
  child.stdout.on('data', (c) => (output += c.toString()));
  child.stderr.on('data', (c) => (output += c.toString()));
  await sleep(600);
  child.kill('SIGKILL');
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  chaosKill = { at: nowIso(), exitCode: exit.code, signal: exit.signal, output: output.trim() };
  timeline.push({
    at: chaosKill.at,
    event: 'backfill-killed',
    text: `first backfill run killed with SIGKILL after ~600ms (exit code ${exit.code}, signal ${
      exit.signal ?? 'n/a'
    }); rows completed before the kill are unknown by design`,
  });
  console.log(
    `    spawned backfill (slowed: --batch-size 100 --throttle-ms 25), waited 600ms, SIGKILLed it (exit code ${exit.code}, signal ${exit.signal ?? 'n/a'})`
  );
  console.log(`    rows completed by the killed run: unknown by design — the rerun must resume via customer_id IS NULL`);
  if (chaosKill.output) console.log(indent(chaosKill.output));
}

async function main() {
  console.log(`=== zero-downtime migration demo ===`);
  console.log(`db: ${dbPath}`);
  console.log(`seed: ${fmt(seedCount)} orders · api: ${baseUrl} · mode: ${chaos ? 'CHAOS (backfill killed mid-run)' : 'normal'}`);

  // (a) Fresh db — seeded in-process, no child needed for this part.
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  createBaselineSchema(db);
  const seeded = seedOrders(db, seedCount);
  db.close();
  console.log(`seeded ${fmt(seeded)} orders into a fresh db`);

  // (b) API server as a child process, exactly like production deployment.
  server = track(
    spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
      env: childEnv,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  collectLines(server.stdout, 'server-stdout');
  collectLines(server.stderr, 'server-stderr');
  await waitForHealth();

  // (c) Live traffic.
  load = new LoadGenerator({ baseUrl });
  load.start();
  timeline.push({ at: nowIso(), event: 'load started (concurrency=4, writeRatio=0.3)' });

  // (d) Warmup so the first phase doesn't pay connection setup noise.
  await sleep(2000);
  warmupSnapshot = load.snapshot();
  timeline.push({
    at: nowIso(),
    event: `warmup done (${warmupSnapshot.total} requests, ${warmupSnapshot.fail} failures)`,
  });
  console.log(`=== warmup ===`);
  console.log(`    ${fmt(warmupSnapshot.total)} requests, ${warmupSnapshot.fail} failures over ${warmupSnapshot.durationMs}ms`);

  // (e) The migration, phase by phase, under fire.
  await runPhase('expand', () => cli('expand'));
  await runPhase('enable-dual', () => cli('enable-dual'));
  if (chaos) await chaosKillBackfill();
  await runPhase('backfill', () => cli('backfill'));
  await runPhase('verify', () => cli('verify'));
  await runPhase('switch-reads', () => cli('switch-reads'));
  await spotCheck();
  await runPhase('soak-v2-reads', async () => {
    await sleep(4000);
    return 'soaking live traffic on joined reads for 4000ms (no CLI action)';
  });
  await runPhase('stop-legacy-writes', () => cli('stop-legacy-writes'));
  await runPhase('verify-post-cutover', () => cli('verify'));
  await runPhase('contract', () => cli('contract', '--yes'));

  // (g) Finish still under load, then tear down.
  await sleep(1500);
  finalSnapshot = await load.stop();
  timeline.push({
    at: nowIso(),
    event: `load stopped (${fmt(finalSnapshot.total)} total, ${finalSnapshot.fail} failures)`,
  });
  apiStats = await fetchJson(`${baseUrl}/stats`);
  await stopServer();
  try {
    statusOutput = await cli('status');
  } catch (err) {
    statusOutput = String(err.output ?? err.message ?? err);
  }
}

function buildReport(success) {
  const final = finalSnapshot ?? { total: 0, ok: 0, fail: 0, failByType: {}, latenciesMs: [], durationMs: 0 };
  const elapsedMs = Date.now() - runStartedAt;
  const errorRate = final.total > 0 ? ((final.fail / final.total) * 100).toFixed(2) : '0.00';
  const lines = [];

  lines.push(`# Zero-downtime migration demo report`);
  lines.push('');
  lines.push(`- generated: ${nowIso()}`);
  lines.push(`- mode: ${chaos ? 'chaos (first backfill run killed with SIGKILL mid-run)' : 'normal'}`);
  lines.push(`- db: ${dbPath} · seed: ${fmt(seedCount)} orders · api: ${baseUrl}`);
  lines.push(`- elapsed wall time: ${(elapsedMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push(`## MIGRATION RESULT: ${success ? 'SUCCESS' : 'FAILURE'}`);
  lines.push('');
  if (success) {
    lines.push(
      `Zero-downtime assertion holds: **${final.fail} failed requests out of ${fmt(final.total)} (${errorRate}%)** across the full expand → contract run under continuous live traffic.`
    );
  } else {
    if (phases.some((p) => p.exitCode !== 0)) lines.push(`- a migration phase exited non-zero (see timeline)`);
    if (final.fail > 0) {
      lines.push(`- load generator saw ${fmt(final.fail)} failed requests out of ${fmt(final.total)} (${errorRate}%):`);
      for (const [type, count] of Object.entries(final.failByType)) lines.push(`  - \`${type}\`: ${count}`);
    }
  }
  lines.push('');

  lines.push(`## Timeline`);
  lines.push('');
  lines.push(`| phase | started (UTC) | duration | requests during phase | failures during phase |`);
  lines.push(`|---|---|---|---|---|`);
  for (const p of phases) {
    lines.push(
      `| ${p.name}${p.exitCode === 0 ? '' : ` **(exit ${p.exitCode})**`} | ${p.startIso} | ${p.durationMs} ms | ${fmt(
        p.loadDelta.total
      )} | ${p.loadDelta.fail} |`
    );
  }
  lines.push('');
  lines.push(`Notable events:`);
  for (const e of timeline) {
    lines.push(`- ${e.at} — ${e.event}${e.text ? ` — ${e.text}` : ''}`);
  }
  lines.push('');
  if (spotCheckResult) {
    lines.push(
      `Read-cutover spot check (${spotCheckResult.at}): \`GET /orders?limit=5\` → read_mode=**${spotCheckResult.read_mode}**, ${spotCheckResult.orders_returned} orders returned.`
    );
    lines.push('');
  }

  lines.push(`## Latency (p50 / p95 / p99 / max, ms — nearest-rank over raw per-request samples)`);
  lines.push('');
  lines.push(`| window | samples | p50 | p95 | p99 | max |`);
  lines.push(`|---|---|---|---|---|---|`);
  const row = (label, arr) => {
    if (!arr || arr.length === 0) return `| ${label} | 0 | - | - | - | - |`;
    return `| ${label} | ${fmt(arr.length)} | ${percentile(arr, 50)} | ${percentile(arr, 95)} | ${percentile(
      arr,
      99
    )} | ${Math.max(...arr)} |`;
  };
  lines.push(row('overall (whole run)', final.latenciesMs));
  for (const name of ['backfill', 'contract']) {
    const p = phases.find((x) => x.name === name);
    lines.push(row(`${name} phase window`, p?.loadDelta.latenciesMs));
  }
  lines.push('');

  lines.push(`## Totals`);
  lines.push('');
  lines.push(`- load generator: ${fmt(final.total)} requests · ${fmt(final.ok)} ok · ${fmt(final.fail)} fail · error rate ${errorRate}%`);
  lines.push(`- load run duration: ${(final.durationMs / 1000).toFixed(1)}s`);
  if (warmupSnapshot) {
    lines.push(`- warmup (2s before first phase): ${fmt(warmupSnapshot.total)} requests, ${warmupSnapshot.fail} failures`);
  }
  if (apiStats) {
    lines.push(
      `- server-side cross-check: ${fmt(apiStats.total_requests)} requests served, ${fmt(apiStats.failed_requests)} rejected/errored`
    );
    lines.push(
      `- database at end: ${fmt(apiStats.orders)} orders · ${fmt(apiStats.customers)} customers · write_mode=${apiStats.write_mode} · read_mode=${apiStats.read_mode}`
    );
  }
  lines.push(`- elapsed wall time: ${(elapsedMs / 1000).toFixed(1)}s`);
  lines.push('');

  if (chaos) {
    lines.push(`## Chaos: backfill killed mid-run`);
    lines.push('');
    lines.push(
      `- ${chaosKill?.at}: spawned \`migrate backfill\` slowed to \`--batch-size 100 --throttle-ms 25\` (so the kill reliably lands mid-run), then SIGKILLed it after ~600ms (exit code ${chaosKill?.exitCode}, signal ${chaosKill?.signal ?? 'n/a'}).`
    );
    lines.push(
      `- rows completed by the killed run are unknown by design — it kept no cursor outside the data; the rerun must resume via \`customer_id IS NULL\`.`
    );
    const rerun = phases.find((p) => p.name === 'backfill');
    lines.push(`- the rerun (normal phase, default batching) completed under the same live traffic:`);
    lines.push('');
    lines.push('```');
    lines.push((rerun?.cliOutput ?? '(missing)').trim());
    lines.push('```');
    lines.push('');
  }

  lines.push(`## Operator CLI output per phase`);
  for (const p of phases) {
    lines.push('');
    lines.push(`### ${p.name} — ${p.startIso} · ${p.durationMs} ms · exit ${p.exitCode}`);
    lines.push('');
    lines.push('```');
    lines.push(p.cliOutput.trim() || '(no output)');
    lines.push('```');
  }
  lines.push('');

  lines.push(`## Server output (captured from the API child process)`);
  lines.push('');
  if (serverLines.length === 0) {
    lines.push('(none)');
  } else {
    for (const l of serverLines) lines.push(`- [${l.tag}] ${l.text}`);
  }
  lines.push('');

  lines.push(`## migrate status (raw, run after the demo)`);
  lines.push('');
  lines.push('```');
  lines.push((statusOutput || '(unavailable)').trim());
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

try {
  await main();
} catch (err) {
  aborted = err;
  if (load) {
    finalSnapshot = await load.stop().catch(() => finalSnapshot);
  }
} finally {
  await stopServer();
}

if (aborted) {
  console.error(`\n=== ABORT ===`);
  console.error(String(aborted.message ?? aborted));
  // A failed run must still leave a truthful report — otherwise the report
  // file keeps the previous run's SUCCESS and lies to whoever reads it next.
  const report = buildReport(false);
  console.log(`\n${report}`);
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report);
  console.error(`\nMIGRATION RESULT: FAILURE (aborted — see phase output above)`);
  process.exitCode = 1;
} else {
  const phasesAllZero = phases.length > 0 && phases.every((p) => p.exitCode === 0);
  const success = phasesAllZero && finalSnapshot !== null && finalSnapshot.fail === 0;
  const report = buildReport(success);
  console.log(`\n${report}`);
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report);
  console.log(`report written to ${path.relative(process.cwd(), REPORT_PATH)}`);
  process.exitCode = success ? 0 : 1;
}
