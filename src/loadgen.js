// Live traffic generator. The success metric for the whole migration exercise
// is that this traffic NEVER sees a failed request while the operator CLI
// mutates schema and flags underneath it. Requests are deliberately shaped like
// real legacy traffic: mixed-case emails, occasional whitespace padding, mixed
// reads/writes/health probes.

const FIRST_NAMES = ['ana', 'raj', 'sam', 'leo', 'mia', 'noah', 'zoe', 'kai', 'ira', 'dev'];
const LAST_NAMES = ['shah', 'patel', 'kim', 'silva', 'costa', 'rossi', 'chan', 'moreau', 'novak', 'rao'];
const DOMAINS = ['corp.io', 'mail.com', 'shop.dev', 'old-billing.example', 'fastmail.test'];

const HEALTH_RATIO = 0.05;
const REQUEST_TIMEOUT_MS = 5000;

// Nearest-rank percentile: p=95 of [1..100] is the 95th sorted sample (95).
// Empty input → 0 so report tables can render without special cases.
export function percentile(arr, p) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1];
}

export class LoadGenerator {
  #random;
  #stopped = false;
  #workers = [];
  #endedAt = null;
  #stats = { startedAt: null, total: 0, ok: 0, fail: 0, failByType: {}, latenciesMs: [] };

  constructor({ baseUrl, concurrency = 4, writeRatio = 0.3, random = Math.random }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.concurrency = concurrency;
    this.writeRatio = writeRatio;
    // Injected rng keeps request selection + payload shape reproducible in tests.
    this.#random = random;
  }

  start() {
    if (this.#stats.startedAt === null) this.#stats.startedAt = Date.now();
    this.#stopped = false;
    this.#endedAt = null;
    for (let i = 0; i < this.concurrency; i++) {
      this.#workers.push(this.#loop());
    }
  }

  // Set the flag, let in-flight requests settle (bounded by the 5s abort
  // timeout), then hand back the final snapshot.
  async stop() {
    this.#stopped = true;
    await Promise.allSettled(this.#workers);
    this.#workers = [];
    if (this.#endedAt === null) this.#endedAt = Date.now();
    return this.snapshot();
  }

  snapshot() {
    const s = this.#stats;
    return {
      startedAt: s.startedAt,
      durationMs: (this.#endedAt ?? Date.now()) - (s.startedAt ?? Date.now()),
      total: s.total,
      ok: s.ok,
      fail: s.fail,
      failByType: { ...s.failByType },
      latenciesMs: [...s.latenciesMs],
    };
  }

  async #loop() {
    while (!this.#stopped) {
      try {
        await this.#oneRequest();
      } catch (err) {
        // #oneRequest handles every failure it knows about; landing here is a
        // loadgen bug — record it rather than silently killing the worker.
        this.#record(false, 0, `loadgen-internal: ${snippet(err?.message ?? err)}`);
      }
    }
  }

  async #oneRequest() {
    const roll = this.#random();
    const healthCut = Math.min(this.writeRatio + HEALTH_RATIO, 1);
    let method;
    let url;
    let body;
    if (roll < this.writeRatio) {
      method = 'POST';
      url = `${this.baseUrl}/orders`;
      body = JSON.stringify(this.#payload());
    } else if (roll < healthCut) {
      method = 'GET';
      url = `${this.baseUrl}/health`;
    } else {
      method = 'GET';
      url = `${this.baseUrl}/orders?limit=${1 + Math.floor(this.#random() * 50)}`;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
        signal: controller.signal,
      });
      let parsed = null;
      let parseError = null;
      try {
        parsed = await res.json();
      } catch (err) {
        parseError = err;
      }
      const latency = Date.now() - startedAt;
      if (parseError) {
        this.#record(false, latency, `parse-error: ${snippet(parseError.message ?? parseError)}`);
      } else if (res.status < 400) {
        this.#record(true, latency);
      } else if (res.status === 400) {
        // A 400 means our own payload was bad — generator's fault, never the
        // migration's. Payload construction must make this unreachable.
        this.#record(false, latency, 'bad-request');
      } else {
        this.#record(false, latency, `HTTP ${res.status}: ${snippet(detailOf(parsed))}`);
      }
    } catch (err) {
      this.#record(false, Date.now() - startedAt, classifyError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // Valid but realistically dirty: ~1-in-5 emails carries whitespace padding or
  // wrong casing, exercising normalize-at-write and backfill normalization.
  #payload() {
    const pick = (arr) => arr[Math.floor(this.#random() * arr.length)];
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    let email = `${first}.${last}@${pick(DOMAINS)}`;
    const dirt = this.#random();
    if (dirt < 0.1) email = `  ${email} `;
    else if (dirt < 0.2) email = email.toUpperCase();
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    return {
      customer_name: `${cap(first)} ${cap(last)}`,
      customer_email: email,
      amount_cents: 100 + Math.floor(this.#random() * 48000),
    };
  }

  #record(ok, latencyMs, failType) {
    const s = this.#stats;
    s.total++;
    s.latenciesMs.push(latencyMs);
    if (ok) {
      s.ok++;
    } else {
      s.fail++;
      s.failByType[failType] = (s.failByType[failType] ?? 0) + 1;
    }
  }
}

function detailOf(parsed) {
  if (parsed && typeof parsed === 'object') {
    const d = parsed.detail ?? parsed.error ?? parsed.message;
    if (d) return String(d);
  }
  return typeof parsed === 'string' && parsed ? parsed : 'no detail';
}

function snippet(s, max = 100) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function classifyError(err) {
  if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)))) return 'timeout';
  const code = err?.code ?? err?.cause?.code;
  if (code) return String(code);
  return snippet(err?.message ?? String(err));
}
