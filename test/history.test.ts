import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";
import { flushEventLog, getEventLog, LogEvent } from "../src/store/event-log";
import { appendWebhookHistory, getWebhookHistory } from "../src/plaid/webhooks";
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
          put: async (key: string, value: unknown) => { data.set(key, value); }
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
