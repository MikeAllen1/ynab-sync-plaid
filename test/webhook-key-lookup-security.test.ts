import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPlaidWebhook } from "../src/plaid/webhooks";
import { SyncLock } from "../src/lock/sync-lock-do";
import type { Env } from "../src/types";

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

test("malformed and oversized Plaid key IDs are rejected before KV access", async () => {
  let reads = 0;
  const env = {
    SYNC_STATE: { get: async () => { reads++; return null; } }
  } as unknown as Env;
  const payload = b64url({ iat: Math.floor(Date.now() / 1000) });
  const signature = "AA";
  for (const kid of ["", "bad/kid", "x".repeat(129)]) {
    const header = b64url({ alg: "ES256", kid });
    assert.equal(await verifyPlaidWebhook(env, "{}", `${header}.${payload}.${signature}`), false);
  }
  assert.equal(reads, 0);
});

test("webhook key cache read budget is globally enforced by the Durable Object", async () => {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    transaction: async (fn: (txn: any) => Promise<any>) => fn({
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => { data.set(key, value); }
    })
  };
  const durableObject = new SyncLock({ storage } as unknown as DurableObjectState);
  const request = () => new Request("https://sync-lock/webhook/key-read", { method: "POST" });
  for (let i = 0; i < 1000; i++) {
    const result = await (await durableObject.fetch(request())).json() as any;
    assert.equal(result.allowed, true);
  }
  const limited = await (await durableObject.fetch(request())).json() as any;
  assert.equal(limited.allowed, false);
});
