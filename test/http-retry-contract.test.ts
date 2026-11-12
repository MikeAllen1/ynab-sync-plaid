import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/util/http";

test("mutating POST is not retried unless explicitly declared safe", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("temporary failure", { status: 503 });
  }) as typeof fetch;
  try {
    const response = await fetchWithRetry("https://provider.test/write", { method: "POST" }, 2);
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("safe retry invokes the request budget callback for every actual attempt", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let reservations = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response("retry", { status: 503, headers: { "Retry-After": "0" } })
      : Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const response = await fetchWithRetry("https://provider.test/read", { method: "GET" }, 1, {
      beforeAttempt: async () => { reservations++; }
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(reservations, 2);
  } finally {
    globalThis.fetch = original;
  }
});
