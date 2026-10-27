import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LoadGenerator, percentile } from '../src/loadgen.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStubServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.method === 'GET' && url.pathname === '/orders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"read_mode":"legacy","orders":[]}');
    } else if (req.method === 'POST' && url.pathname === '/orders') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":1}');
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('LoadGenerator drives a healthy API with zero failures', async () => {
  const server = await startStubServer();
  const { port } = server.address();
  try {
    const lg = new LoadGenerator({ baseUrl: `http://127.0.0.1:${port}`, concurrency: 2, writeRatio: 0.5 });
    lg.start();
    await sleep(700);
    const snap = await lg.stop();
    assert.ok(snap.total >= 3, `expected at least 3 requests, got ${snap.total}`);
    assert.equal(snap.fail, 0);
    assert.equal(snap.ok, snap.total);
    assert.equal(snap.latenciesMs.length, snap.total);
    assert.deepEqual(snap.failByType, {});
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('percentile uses nearest-rank and tolerates empty input', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(arr, 50), 50);
  assert.equal(percentile(arr, 95), 95);
  assert.equal(percentile([], 50), 0);
});

test('LoadGenerator classifies failures when the API is unreachable', async () => {
  // Grab an ephemeral port, then close it so nothing is listening there.
  const holder = http.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const { port } = holder.address();
  await new Promise((r) => holder.close(r));

  const lg = new LoadGenerator({ baseUrl: `http://127.0.0.1:${port}`, concurrency: 2, writeRatio: 0.5 });
  lg.start();
  await sleep(300);
  const snap = await lg.stop();
  assert.ok(snap.total > 0, 'expected some attempts against the closed port');
  assert.equal(snap.fail, snap.total);
  assert.ok(Object.keys(snap.failByType).length >= 1, `failByType not populated: ${JSON.stringify(snap.failByType)}`);
});
