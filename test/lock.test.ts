import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSyncLock, renewSyncLock } from "../src/lock/lock";
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
