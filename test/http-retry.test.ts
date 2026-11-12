import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, readJsonBody, retryAfterDelayMs } from "../src/util/http";
import { activeLeases, LEASE_RENEW_EVERY_MS } from "../src/lock/lock";
import type { Env } from "../src/types";

test("financial POST is not retried after a retryable HTTP response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("unavailable", { status: 503 }); };
  try {
    const response = await fetchWithRetry("https://example.test/write", { method: "POST" });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("financial POST is not retried after an ambiguous transport failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("connection reset"); };
  try {
    await assert.rejects(fetchWithRetry("https://example.test/write", { method: "POST" }), /connection reset/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("safe GET retries transient HTTP responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response("unavailable", { status: 503 })
    : Response.json({ ok: true });
  try {
    const response = await fetchWithRetry("https://example.test/read", { method: "GET" }, 1);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("explicitly safe Plaid-style POST retries transient HTTP responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response("rate limited", { status: 429 })
    : Response.json({ ok: true });
  try {
    const response = await fetchWithRetry("https://example.test/plaid-read", { method: "POST" }, 1, true);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("a long outbound request revalidates the lease before its response is consumed", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const base = originalNow();
  let clock = base;
  let renewals = 0;
  const env = {
    SYNC_LOCK: {
      idFromName: () => "global",
      get: () => ({ fetch: async () => Response.json({ renewed: ++renewals === 1 }) })
    }
  } as unknown as Env;
  const lock = { id: "lease-long-call", mode: "durable-object" as const };
  activeLeases.set(lock.id, { env, lock, renewedAt: base - LEASE_RENEW_EVERY_MS - 1 });
  Date.now = () => clock;
  globalThis.fetch = async () => {
    clock += LEASE_RENEW_EVERY_MS + 1;
    return Response.json({ committed: true });
  };
  try {
    await assert.rejects(
      fetchWithRetry("https://example.test/slow-read", { method: "GET" }, 0),
      /no longer owned.*aborting financial writes/
    );
    assert.equal(renewals, 2, "lease is checked both before and after the slow request");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    activeLeases.delete(lock.id);
  }
});


test("fetchWithRetry retries 429 using Retry-After and returns the successful response", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  let calls = 0;
  (globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms?: number) => {
    waits.push(Number(ms || 0));
    queueMicrotask(fn);
    return 0;
  };
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } });
    return Response.json({ ok: true });
  };
  try {
    const response = await fetchWithRetry("https://provider.test/resource", { method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2000]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("fetchWithRetry defers a Retry-After longer than the bounded Worker retry window", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  let calls = 0;
  (globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms?: number) => {
    waits.push(Number(ms || 0));
    queueMicrotask(fn);
    return 0;
  };
  globalThis.fetch = async () => {
    calls++;
    return new Response("busy", { status: 503, headers: { "Retry-After": "60" } });
  };
  try {
    const response = await fetchWithRetry("https://provider.test/resource", { method: "GET" }, 2);
    assert.equal(response.status, 503);
    assert.equal(calls, 1, "a provider Retry-After of 60 seconds is returned to the scheduler, not shortened");
    assert.deepEqual(waits, []);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("fetchWithRetry does not retry permanent client errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  };
  try {
    const response = await fetchWithRetry("https://provider.test/resource", { method: "GET" });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readJsonBody preserves JSON and safely summarizes HTML gateway errors", async () => {
  assert.deepEqual(await readJsonBody(Response.json({ ok: true })), { ok: true });
  const parsed = await readJsonBody(new Response("<html><body>Bad Gateway</body></html>", { status: 502 }));
  assert.match(parsed.non_json_response, /Bad Gateway/);
  assert.ok(parsed.non_json_response.length <= 120);
});


test("Retry-After accepts HTTP dates without shortening provider delays", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterDelayMs("Thu, 01 Jan 2026 00:00:03 GMT", 0, now), 3000);
  assert.equal(retryAfterDelayMs("120", 0, now), 120000);
});

test("every outbound call is bounded by a timeout unless the caller brings its own signal", async () => {
  const originalFetch = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => { seen.push(init?.signal); return Response.json({ ok: true }); }) as any;
  try {
    await fetchWithRetry("https://example.test/read", { method: "GET" });
    await fetchWithRetry("https://example.test/write", { method: "POST" });
    const own = new AbortController().signal;
    await fetchWithRetry("https://example.test/read", { method: "GET", signal: own });
    assert.ok(seen[0] instanceof AbortSignal);
    assert.ok(seen[1] instanceof AbortSignal);
    assert.equal(seen[2], own);
  } finally { globalThis.fetch = originalFetch; }
});
