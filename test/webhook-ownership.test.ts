import { test } from "node:test";
import assert from "node:assert/strict";
import { foreignWebhookReason, handlePlaidWebhook } from "../src/plaid/webhooks";
import type { Env } from "../src/types";

function kv(initial: Record<string, string> = {}): KVNamespace {
  const data = new Map(Object.entries(initial));
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => { data.set(k, v); },
    delete: async (k: string) => { data.delete(k); }
  } as unknown as KVNamespace;
}
const mine = [{ nickname: "checking", plaid_access_token: "a", plaid_account_id: "p1", ynab_account_id: "y1", item_id: "item-mine" }];
const envWith = (accounts: any[], extra: Record<string, string> = {}) =>
  ({ PLAID_ENV: "production", SYNC_STATE: kv({ account_map: JSON.stringify(accounts), ...extra }) } as unknown as Env);

test("a signed webhook about someone else's bank login is dropped before any side effect", async () => {
  // Plaid's signing keys are shared by every Plaid customer, so a valid signature alone
  // doesn't make the Item yours. No SYNC_LOCK here: reaching the receipt claim would throw.
  const env = envWith(mine);
  let scheduled = 0;
  const ctx = { waitUntil: () => { scheduled++; } } as unknown as ExecutionContext;
  for (const webhook_type of ["TRANSACTIONS", "ITEM"]) {
    const r = await handlePlaidWebhook(JSON.stringify({ webhook_type, webhook_code: webhook_type === "ITEM" ? "PENDING_EXPIRATION" : "SYNC_UPDATES_AVAILABLE", item_id: "item-stranger", environment: "production" }), env, ctx);
    assert.equal(r.action, "ignored_not_ours");
  }
  assert.equal(scheduled, 0);
  assert.equal(await env.SYNC_STATE.get("item_pending_expiration:item-stranger"), null);
});

test("your own logins, a just-linked login and the wrong environment", async () => {
  assert.equal(await foreignWebhookReason(envWith(mine), { item_id: "item-mine", environment: "production" }), null);
  assert.equal(await foreignWebhookReason(envWith(mine, { "pending_item:item-new": "1" }), { item_id: "item-new" }), null);
  assert.match(String(await foreignWebhookReason(envWith(mine), { item_id: "item-mine", environment: "sandbox" })), /environment/);
});

test("an account whose login isn't known yet lets webhooks through (never drops your own)", async () => {
  const legacy = [{ nickname: "old", plaid_access_token: "a", plaid_account_id: "p1", ynab_account_id: "y1" }];
  assert.equal(await foreignWebhookReason(envWith(legacy), { item_id: "item-anything" }), null);
  // Once a health check has learned that account's login, strangers are dropped again.
  const health = JSON.stringify({ "item-old": { item_id: "item-old", nicknames: ["old"] } });
  const env = envWith(legacy);
  const { ITEM_HEALTH_KV_KEY } = await import("../src/health/items");
  await env.SYNC_STATE.put(ITEM_HEALTH_KV_KEY, health);
  assert.equal(await foreignWebhookReason(env, { item_id: "item-old" }), null);
  assert.ok(await foreignWebhookReason(env, { item_id: "item-anything" }));
});
