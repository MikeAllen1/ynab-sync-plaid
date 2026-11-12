import { test } from "node:test";
import assert from "node:assert/strict";
import { withDurableAccountState } from "../src/store/durable-state";
import { makeTestSyncLock } from "./durable-object-fixture";
import type { Env } from "../src/types";

function makeKv(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const kv = {
    get: async (k: string) => values.get(k) ?? null,
    put: async (k: string, v: string) => { values.set(k, v); },
    delete: async (k: string) => { values.delete(k); },
    list: async ({ prefix = "" }: any = {}) => ({ keys: [...values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true })
  } as unknown as KVNamespace;
  return { kv, values };
}

test("per-account sync state moves to the Durable Object; everything else stays in KV", async () => {
  const { kv, values } = makeKv({ "cursor:p1": "cursor-from-kv", "posted:p1": "{\"tx\":\"id\"}", last_sync_summary: "summary" });
  const env = withDurableAccountState({ SYNC_STATE: kv, SYNC_LOCK: makeTestSyncLock() } as unknown as Env);
  assert.equal(await env.SYNC_STATE.get("cursor:p1"), "cursor-from-kv", "existing KV state is migrated on first use");
  assert.equal(await env.SYNC_STATE.get("posted:p1"), "{\"tx\":\"id\"}");
  await env.SYNC_STATE.put("cursor:p1", "cursor-2");
  assert.equal(await env.SYNC_STATE.get("cursor:p1"), "cursor-2");
  assert.equal(values.get("cursor:p1"), "cursor-from-kv", "the KV copy is no longer written");
  await env.SYNC_STATE.put("last_sync_summary", "new summary");
  assert.equal(values.get("last_sync_summary"), "new summary", "non-state keys still go to KV");
});

test("a deleted value is not brought back from the old KV copy", async () => {
  const { kv } = makeKv({ "bootstrapped:p1": "1" });
  const env = withDurableAccountState({ SYNC_STATE: kv, SYNC_LOCK: makeTestSyncLock() } as unknown as Env);
  assert.equal(await env.SYNC_STATE.get("bootstrapped:p1"), "1");
  await env.SYNC_STATE.delete("bootstrapped:p1");
  assert.equal(await env.SYNC_STATE.get("bootstrapped:p1"), null);
  // A second isolate (fresh wrapper) sees the migration is done and doesn't re-import.
  const env2 = withDurableAccountState({ SYNC_STATE: { ...kv } as KVNamespace, SYNC_LOCK: (env as any).SYNC_LOCK } as unknown as Env);
  assert.equal(await env2.SYNC_STATE.get("bootstrapped:p1"), null);
});

test("a late import after migration is refused", async () => {
  const lock = makeTestSyncLock();
  const stub = lock.get(lock.idFromName("global"));
  const post = (path: string, body: unknown) => stub.fetch(`https://sync-lock${path}`, { method: "POST", body: JSON.stringify(body) }).then(r => r.json() as Promise<any>);
  await post("/state/import", { entries: [["cursor:p1", "a"]], mark_migrated: true });
  await post("/state/delete", { key: "cursor:p1" });
  const late = await post("/state/import", { entries: [["cursor:p1", "stale"]], mark_migrated: true });
  assert.equal(late.already_migrated, true);
  const got = await stub.fetch("https://sync-lock/state/get?key=cursor:p1").then(r => r.json() as Promise<any>);
  assert.equal(got.value, null);
});

test("only allowlisted state keys are accepted by the Durable Object", async () => {
  const lock = makeTestSyncLock();
  const resp = await lock.get(lock.idFromName("global")).fetch("https://sync-lock/state/put", { method: "POST", body: JSON.stringify({ key: "lock", value: "x" }) });
  assert.equal(resp.status, 400);
});

test("without the Durable Object binding, env is unchanged", () => {
  const { kv } = makeKv({});
  const env = { SYNC_STATE: kv } as unknown as Env;
  assert.equal(withDurableAccountState(env), env);
});
