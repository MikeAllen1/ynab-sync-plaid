import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSyncLock } from "../src/lock/lock";
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
