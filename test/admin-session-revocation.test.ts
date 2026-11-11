import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";

test("admin session registry validates, expires, and revokes sessions", async () => {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    transaction: async (fn: (txn: any) => Promise<any>) => fn({
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => { data.set(key, value); },
      delete: async (key: string) => data.delete(key)
    })
  };
  const durableObject = new SyncLock({ storage } as unknown as DurableObjectState);
  const fingerprint = "b".repeat(64);
  const request = (path: string, expiresAt?: number) => new Request("https://sync-lock" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint, ...(expiresAt === undefined ? {} : { expiresAt }) })
  });
  const created = await durableObject.fetch(request("/session/create", Date.now() + 60000));
  assert.equal(created.status, 200);
  const valid = await (await durableObject.fetch(request("/session/validate"))).json() as any;
  assert.equal(valid.valid, true);
  const revoked = await durableObject.fetch(request("/session/revoke"));
  assert.equal(revoked.status, 200);
  const afterRevoke = await (await durableObject.fetch(request("/session/validate"))).json() as any;
  assert.equal(afterRevoke.valid, false);
});

test("admin session registry rejects invalid and overlong expirations", async () => {
  const storage = {
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => undefined,
    transaction: async (fn: (txn: any) => Promise<any>) => fn({})
  };
  const durableObject = new SyncLock({ storage } as unknown as DurableObjectState);
  const response = await durableObject.fetch(new Request("https://sync-lock/session/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint: "c".repeat(64), expiresAt: Date.now() + 7200000 })
  }));
  assert.equal(response.status, 400);
});
