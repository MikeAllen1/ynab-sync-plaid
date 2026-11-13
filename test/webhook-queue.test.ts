import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeWebhookSyncBatch, handlePlaidWebhook } from "../src/plaid/webhooks";
import { acquireSyncLock, releaseSyncLock } from "../src/lock/lock";
import { withDurableAccountState } from "../src/store/durable-state";
import { makeWorld } from "./sim/world";
import type { Env, WebhookSyncMessage } from "../src/types";

function fakeMessage(body: WebhookSyncMessage, attempts = 1) {
  const m: any = { id: crypto.randomUUID(), timestamp: new Date(), body, attempts, acked: false, retried: null as any };
  m.ack = () => { m.acked = true; };
  m.retry = (o?: any) => { m.retried = o || {}; };
  return m;
}
const body = (item: string) => JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: item, environment: "production" });

test("with SYNC_QUEUE, a transactions webhook is queued instead of run in the request's background time", async () => {
  const w = makeWorld({ accounts: 3, history: 0 });
  const sent: any[] = [];
  const env = withDurableAccountState({ ...w.env, SYNC_QUEUE: { send: async (m: any) => { sent.push(m); } } } as unknown as Env);
  let background = 0;
  const ctx = { waitUntil: () => { background++; } } as unknown as ExecutionContext;
  const restore = w.install();
  try {
    const r = await handlePlaidWebhook(body("item-0"), env, ctx, "jwt-a");
    assert.equal(r.action, "sync_queued");
    assert.equal(background, 0);
    assert.deepEqual(sent.map(m => [m.item_id, m.webhook_code]), [["item-0", "SYNC_UPDATES_AVAILABLE"]]);
  } finally { restore(); }
});

test("if the queue can't be reached, the webhook still syncs the old way", async () => {
  const w = makeWorld({ accounts: 3, history: 0 });
  const env = withDurableAccountState({ ...w.env, SYNC_QUEUE: { send: async () => { throw new Error("queue down"); } } } as unknown as Env);
  let background = 0;
  const ctx = { waitUntil: (p: Promise<unknown>) => { background++; p.catch(() => {}); } } as unknown as ExecutionContext;
  const restore = w.install();
  try {
    const r = await handlePlaidWebhook(body("item-0"), env, ctx, "jwt-b");
    assert.equal(r.action, "sync_scheduled");
    assert.equal(background, 1);
  } finally { restore(); }
});

test("the consumer syncs once per bank login per batch and acks", async () => {
  const w = makeWorld({ accounts: 3, history: 0 });
  const env = withDurableAccountState(w.env);
  const restore = w.install();
  try {
    const msgs = [0, 1, 2].map(() => fakeMessage({ item_id: "item-0", webhook_code: "SYNC_UPDATES_AVAILABLE", ts: "" }));
    w.resetCounters();
    await consumeWebhookSyncBatch({ messages: msgs, queue: "q" } as any, env);
    assert.ok(msgs.every(m => m.acked && !m.retried));
    const syncs = [...w.byPath.entries()].filter(([k]) => k.includes("/transactions/sync")).reduce((n, [, v]) => n + v, 0);
    assert.ok(syncs <= 3, `one coalesced sync (3 accounts share one feed page), saw ${syncs} feed reads`);
  } finally { restore(); }
});

test("a consumer that finds another sync running retries a minute later, then gives up to the cron", async () => {
  const w = makeWorld({ accounts: 3, history: 0 });
  const env = withDurableAccountState(w.env);
  const restore = w.install();
  try {
    const held = await acquireSyncLock(env);
    const first = fakeMessage({ item_id: "item-0", webhook_code: "SYNC_UPDATES_AVAILABLE", ts: "" }, 1);
    const last = fakeMessage({ item_id: "item-1", webhook_code: "SYNC_UPDATES_AVAILABLE", ts: "" }, 3);
    await consumeWebhookSyncBatch({ messages: [first, last], queue: "q" } as any, env);
    assert.deepEqual(first.retried, { delaySeconds: 60 });
    assert.equal(last.acked, true, "after its retries, the item is left to the cron (it was marked due)");
    await releaseSyncLock(env, held!);
  } finally { restore(); }
});
