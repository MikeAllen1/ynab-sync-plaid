import { test } from "node:test";
import assert from "node:assert/strict";
import { syncAll } from "../src/sync/run";
import type { Env } from "../src/types";

test("syncAll fails closed when the Durable Object lock binding is missing", async () => {
  const account = {
    nickname: "checking",
    plaid_access_token: "plaid-access",
    plaid_account_id: "plaid-checking",
    ynab_account_id: "ynab-checking",
    institution: "Example Bank"
  };
  const values = new Map<string, string>([["sync:enabled", "true"]]);
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]),
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls++;
    throw new Error("No provider calls should occur without the global lock");
  };
  try {
    const result = await syncAll(env, { trigger: "manual" });
    assert.equal(result.status, "lock_unavailable");
    assert.equal(outboundCalls, 0);
    assert.equal(values.has("cursor:plaid-checking"), false);
    assert.ok(values.has("last_error"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
