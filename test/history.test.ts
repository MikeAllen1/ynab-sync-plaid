import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";
import { flushEventLog, getEventLog, LogEvent } from "../src/store/event-log";
import { appendWebhookHistory, getWebhookHistory } from "../src/plaid/webhooks";
import { appendUndo, getUndoLog } from "../src/sync/undo";
import type { Env } from "../src/types";

function makeEnv(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const data = new Map<string, unknown>();
  let transactionTail = Promise.resolve();
  const storage: any = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    transaction: async (fn: (txn: any) => Promise<any>) => {
      let release!: () => void;
      const previous = transactionTail;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        return await fn({
          get: async (key: string) => data.get(key),
          put: async (key: string, value: unknown) => { data.set(key, value); },
          delete: async (key: string) => data.delete(key)
        });
      } finally { release(); }
    }
  };
  const durableObject = new SyncLock({ storage } as any);
  const namespace: any = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => durableObject.fetch(new Request(input, init)) })
  };
  const env = {
    SYNC_LOCK: namespace,
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;
  return { env, data, values };
}

test("concurrent event-log flushes preserve every appended batch", async () => {
  const { env } = makeEnv();
  const event = (action: string): LogEvent => ({
    ts: new Date().toISOString(), account: "checking", action
  });
  await Promise.all([
    flushEventLog(env, [event("pending_import")]),
    flushEventLog(env, [event("posted_gapfill")]),
    flushEventLog(env, [event("pending_retire")])
  ]);
  const actions = (await getEventLog(env)).map(e => e.action);
  assert.equal(actions.length, 3);
  assert.deepEqual(new Set(actions), new Set(["pending_import", "posted_gapfill", "pending_retire"]));
});

test("concurrent webhook appends preserve events and migrate the legacy KV history", async () => {
  const legacy = [{ webhook_code: "OLD_EVENT" }];
  const { env } = makeEnv({ webhook_history: JSON.stringify(legacy) });
  await Promise.all([
    appendWebhookHistory(env, { webhook_code: "EVENT_A" }),
    appendWebhookHistory(env, { webhook_code: "EVENT_B" }),
    appendWebhookHistory(env, { webhook_code: "EVENT_C" })
  ]);
  const codes = (await getWebhookHistory(env)).map(e => e.webhook_code);
  assert.equal(codes.length, 4);
  assert.ok(codes.includes("OLD_EVENT"));
  assert.ok(codes.includes("EVENT_A"));
  assert.ok(codes.includes("EVENT_B"));
  assert.ok(codes.includes("EVENT_C"));
});

test("Durable Object rejects unknown history keys and oversized batches", async () => {
  const { env } = makeEnv();
  const stub = env.SYNC_LOCK!.get(env.SYNC_LOCK!.idFromName("global"));
  const badKey = await stub.fetch("https://sync-lock/history/append", {
    method: "POST", body: JSON.stringify({ key: "arbitrary", items: [{}], initial: [] })
  });
  assert.equal(badKey.status, 400);
  const tooMany = await stub.fetch("https://sync-lock/history/append", {
    method: "POST", body: JSON.stringify({ key: "webhook_history", items: Array(21).fill({}), initial: [] })
  });
  assert.equal(tooMany.status, 400);
});

test("concurrent lock acquisitions are serialized by a storage transaction", async () => {
  const { env } = makeEnv();
  const stub = env.SYNC_LOCK!.get(env.SYNC_LOCK!.idFromName("global"));
  const [a, b] = await Promise.all([
    stub.fetch("https://sync-lock/acquire", { method: "POST" }).then(r => r.json() as Promise<any>),
    stub.fetch("https://sync-lock/acquire", { method: "POST" }).then(r => r.json() as Promise<any>)
  ]);
  assert.equal([a, b].filter(x => x.acquired).length, 1);
  const holder = a.acquired ? a.id : b.id;
  const wrongRelease = await stub.fetch("https://sync-lock/release?id=not-the-holder", { method: "POST" }).then(r => r.json() as Promise<any>);
  assert.equal(wrongRelease.released, false);
  const release = await stub.fetch(`https://sync-lock/release?id=${encodeURIComponent(holder)}`, { method: "POST" }).then(r => r.json() as Promise<any>);
  assert.equal(release.released, true);
});

test("concurrent undo appends preserve every created row and group by run id", async () => {
  const { env } = makeEnv();
  await Promise.all([
    appendUndo(env, "run-1", "cron", [{ id: "row-a", account: "checking" }]),
    appendUndo(env, "run-1", "cron", [{ id: "row-b", account: "savings" }]),
    appendUndo(env, "run-2", "manual", [{ id: "row-c", account: "checking" }])
  ]);
  const log = await getUndoLog(env);
  assert.equal(log.length, 2, "same-run rows should be grouped in one undo batch");
  const run1 = log.find(batch => batch.run_id === "run-1");
  assert.deepEqual(new Set(run1?.items.map(item => item.id)), new Set(["row-a", "row-b"]));
  assert.equal(run1?.count, 2);
  assert.ok(log.some(batch => batch.run_id === "run-2"));
});

test("undo history supports transactional replacement after an undo operation", async () => {
  const { env } = makeEnv();
  await appendUndo(env, "run-1", "manual", [{ id: "row-a", account: "checking" }]);
  const stub = env.SYNC_LOCK!.get(env.SYNC_LOCK!.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/history/replace", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "undo_log", items: [] })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await getUndoLog(env), []);
});
