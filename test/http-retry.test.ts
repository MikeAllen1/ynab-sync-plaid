import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, readJsonBody } from "../src/util/http";

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

test("fetchWithRetry caps Retry-After and stops after the configured retry count", async () => {
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
    assert.equal(calls, 3);
    assert.deepEqual(waits, [10000, 10000]);
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
