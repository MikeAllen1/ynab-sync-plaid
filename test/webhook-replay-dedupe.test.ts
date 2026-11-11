import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";

test("Durable Object atomically claims a webhook fingerprint once", async () => {
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
  const state = { storage } as unknown as DurableObjectState;
  const durableObject = new SyncLock(state);
  const fingerprint = "a".repeat(64);
  const request = () => new Request("https://sync-lock/webhook/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint })
  });
  const first = await (await durableObject.fetch(request())).json() as any;
  const second = await (await durableObject.fetch(request())).json() as any;
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  const stored = data.get("webhook:seen") as Record<string, number>;
  assert.deepEqual(Object.keys(stored), [fingerprint]);
});
