import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/util/http";

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
