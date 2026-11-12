import { test } from "node:test";
import assert from "node:assert/strict";
import { plaidCall } from "../src/plaid/client";
import type { Env } from "../src/types";

const env = {
  PLAID_ENV: "production",
  PLAID_CLIENT_ID: "client",
  PLAID_SECRET: "secret"
} as Env;

test("Plaid read-only POST endpoint retries a transient response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ error_code: "INTERNAL", error_message: "retry" }, { status: 503 })
    : Response.json({ added: [], modified: [], removed: [], next_cursor: "next", has_more: false });
  try {
    const result = await plaidCall(env, "/transactions/sync", { cursor: "start" });
    assert.equal(result.next_cursor, "next");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid refresh action is not retried after an ambiguous service response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error_code: "INTERNAL" }, { status: 503 }); };
  try {
    await assert.rejects(plaidCall(env, "/transactions/refresh", { access_token: "access" }), /Plaid \/transactions\/refresh/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid configuration mutation is not retried after a transport exception", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("connection reset"); };
  try {
    await assert.rejects(plaidCall(env, "/item/webhook/update", { access_token: "access" }), /connection reset/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
