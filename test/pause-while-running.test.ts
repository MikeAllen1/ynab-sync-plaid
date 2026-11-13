import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { acquireSyncLock, isSyncEnabled, releaseSyncLock } from "../src/lock/lock";
import { makeTestSyncLock } from "./durable-object-fixture";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
function kv(): KVNamespace {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => { data.set(k, v); },
    delete: async (k: string) => { data.delete(k); },
    list: async () => ({ keys: [], list_complete: true })
  } as unknown as KVNamespace;
}
const post = (env: Env, path: string) => workerEntry.fetch(new Request(`https://worker.example${path}`, {
  method: "POST", headers: { "x-admin-token": "t" }
}), env, ctx);

test("Pause takes effect while a sync holds the lock (it used to answer 409 busy)", async () => {
  const env = { ADMIN_TOKEN: "t", SYNC_STATE: kv(), SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  const running = await acquireSyncLock(env);   // a sync in progress
  assert.ok(running);
  const paused = await post(env, "/pause");
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as any).sync_enabled, false);
  // The running sync's own checks (before each account, and just before writing) see it.
  const { withDurableAccountState } = await import("../src/store/durable-state");
  assert.equal(await isSyncEnabled(withDurableAccountState(env)), false);
  const resumed = await post(env, "/resume");
  assert.equal(resumed.status, 200);
  assert.equal(await isSyncEnabled(withDurableAccountState(env)), true);
  await releaseSyncLock(env, running!);
});
