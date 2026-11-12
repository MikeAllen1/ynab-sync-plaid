import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/util/http";
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
