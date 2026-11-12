import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function kv(initial: Record<string, string> = {}): KVNamespace {
  const data = new Map(Object.entries(initial));
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => { data.set(k, v); },
    delete: async (k: string) => { data.delete(k); }
  } as unknown as KVNamespace;
}

test("a new bank link registers the worker's webhook on the Item", async () => {
  const env = { ADMIN_TOKEN: "t", PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", SYNC_STATE: kv() } as unknown as Env;
  const originalFetch = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = async (_url: any, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ link_token: "link-x", expiration: "2026-01-01T00:00:00Z", request_id: "r" });
  };
  try {
    const resp = await workerEntry.routeFetch(new Request("https://worker.example/link-token", {
      method: "POST", headers: { "x-admin-token": "t", Origin: "https://worker.example", "Content-Type": "application/json" }, body: "{}"
    }), env, ctx);
    assert.equal(resp.status, 200);
    assert.equal(sent.webhook, "https://worker.example/webhook");
  } finally { globalThis.fetch = originalFetch; }
});

test("Re-register webhooks covers bank logins whose accounts are still switched off", async () => {
  const accounts = [{ nickname: "new-card", plaid_access_token: "access-new", plaid_account_id: "p1", ynab_account_id: "y1" }];
  const env = {
    ADMIN_TOKEN: "t", PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s",
    SYNC_STATE: kv({ account_map: JSON.stringify(accounts), account_automation_settings: JSON.stringify([{ nickname: "new-card", sync_enabled: false }]) })
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = async (_url: any, init?: RequestInit) => {
    tokens.push(JSON.parse(String(init?.body)).access_token);
    return Response.json({ item: { item_id: "item-1" }, request_id: "r" });
  };
  try {
    const resp = await workerEntry.routeFetch(new Request("https://worker.example/configure-webhooks", {
      method: "POST", headers: { "x-admin-token": "t", Origin: "https://worker.example" }
    }), env, ctx);
    const body: any = await resp.json();
    assert.equal(body.ok, true);
    assert.deepEqual(tokens, ["access-new"]);
  } finally { globalThis.fetch = originalFetch; }
});
