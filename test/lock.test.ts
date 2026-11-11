import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSyncLock, renewSyncLock, keepLeaseAlive, activeLeases, LEASE_RENEW_EVERY_MS } from "../src/lock/lock";
import type { Env } from "../src/types";

test("write lock fails closed when the Durable Object binding is missing", async () => {
  const writes: string[] = [];
  const env = {
    SYNC_STATE: {
      get: async () => null,
      put: async (key: string) => { writes.push(key); },
      delete: async () => {},
    },
  } as unknown as Env;
  const lock = await acquireSyncLock(env);
  assert.equal(lock, null);
  assert.deepEqual(writes, []);
});

test("a lost Durable Object lease aborts the operation instead of continuing unprotected", async () => {
  const env = {
    SYNC_LOCK: {
      idFromName: () => "global",
      get: () => ({ fetch: async () => Response.json({ renewed: false }) })
    }
  } as unknown as Env;
  await assert.rejects(
    () => renewSyncLock(env, { id: "expired-owner", mode: "durable-object" }),
    /no longer owned.*aborting financial writes/
  );
});

test("an unavailable Durable Object lease renewal aborts the operation", async () => {
  const env = {
    SYNC_LOCK: {
      idFromName: () => "global",
      get: () => ({ fetch: async () => { throw new Error("network unavailable"); } })
    }
  } as unknown as Env;
  await assert.rejects(
    () => renewSyncLock(env, { id: "owner", mode: "durable-object" }),
    /lease renewal failed.*aborting financial writes/
  );
});

test("a successful Durable Object lease renewal is accepted", async () => {
  const env = {
    SYNC_LOCK: {
      idFromName: () => "global",
      get: () => ({ fetch: async () => Response.json({ renewed: true }) })
    }
  } as unknown as Env;
  await assert.doesNotReject(
    () => renewSyncLock(env, { id: "owner", mode: "durable-object" })
  );
});

test("a transient renewal failure does not suppress the next lease check", async () => {
  let attempts = 0;
  const env = {
    SYNC_LOCK: {
      idFromName: () => "global",
      get: () => ({
        fetch: async () => {
          attempts++;
          if (attempts === 1) throw new Error("temporary Durable Object outage");
          return Response.json({ renewed: true });
        }
      })
    }
  } as unknown as Env;
  const lock = { id: "owner-retry", mode: "durable-object" as const };
  const originalRenewedAt = Date.now() - LEASE_RENEW_EVERY_MS - 1000;
  activeLeases.set(lock.id, { env, lock, renewedAt: originalRenewedAt });
  try {
    await assert.rejects(() => keepLeaseAlive(), /lease renewal failed/);
    assert.equal(activeLeases.get(lock.id)?.renewedAt, originalRenewedAt, "failed renewal must not advance the throttle timestamp");
    await keepLeaseAlive();
    assert.equal(attempts, 2, "the next outbound operation must retry the renewal");
    assert.ok((activeLeases.get(lock.id)?.renewedAt || 0) > originalRenewedAt);
  } finally {
    activeLeases.delete(lock.id);
  }
});
