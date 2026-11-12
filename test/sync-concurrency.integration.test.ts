import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";
import { syncAll } from "../src/sync/run";
import { resetRunCache } from "../src/plaid/fetch";
import type { Env } from "../src/types";

function makeDurableObjectNamespace() {
  const data = new Map<string, unknown>();
  let tail = Promise.resolve();
  const storage: any = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    transaction: async (fn: (txn: any) => Promise<any>) => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
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
  const object = new SyncLock({ storage } as any);
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)) })
  };
}

test("two overlapping syncAll calls cannot enter the same account's provider workflow", async () => {
  const account = {
    nickname: "checking",
    plaid_access_token: "plaid-access",
    plaid_account_id: "plaid-checking",
    ynab_account_id: "ynab-checking",
    institution: "Example Bank"
  };
  const values = new Map<string, string>([
    ["sync:enabled", "true"],
    ["bootstrapped:plaid-checking", "1"],
    ["account_automation_settings", JSON.stringify([{ nickname: "checking", sync_enabled: true, audit_enabled: true }])]
  ]);
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]),
    PLAID_ENV: "production",
    PLAID_CLIENT_ID: "client",
    PLAID_SECRET: "secret",
    YNAB_TOKEN: "token",
    YNAB_BUDGET_ID: "budget",
    TIMEZONE: "UTC",
    SYNC_LOCK: makeDurableObjectNamespace(),
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  let providerSyncCalls = 0;
  let releaseFirst!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "production.plaid.com" && url.pathname === "/transactions/sync") {
      providerSyncCalls++;
      signalEntered();
      await gate;
      return Response.json({ added: [], modified: [], removed: [], next_cursor: "cursor-next", has_more: false });
    }
    if (url.hostname === "production.plaid.com" && url.pathname === "/transactions/get") {
      return Response.json({ transactions: [], total_transactions: 0 });
    }
    if (url.hostname === "production.plaid.com" && url.pathname === "/accounts/get") {
      return Response.json({ accounts: [{ account_id: "plaid-checking", mask: "1234" }] });
    }
    if (url.hostname === "api.ynab.com" && url.pathname.endsWith("/accounts")) {
      return Response.json({ data: { accounts: [{ id: "ynab-checking", name: "Checking", type: "checking", closed: false, deleted: false }] } });
    }
    if (url.hostname === "api.ynab.com" && url.pathname.endsWith("/accounts/ynab-checking/transactions")) {
      return Response.json({ data: { transactions: [] } });
    }
    throw new Error("Unexpected request " + url.hostname + url.pathname);
  };
  try {
    resetRunCache();
    const first = syncAll(env, { trigger: "manual", runId: "concurrent-1" });
    await entered;
    const second = await syncAll(env, { trigger: "manual", runId: "concurrent-2" });
    assert.equal(second.status, "skipped_locked");
    assert.equal(providerSyncCalls, 1, "the second execution must not call Plaid while the first owns the lock");
    releaseFirst();
    const completed = await first;
    assert.equal(completed.results[0].status, "ok");
    assert.equal(providerSyncCalls, 1);
  } finally {
    releaseFirst();
    globalThis.fetch = originalFetch;
    resetRunCache();
  }
});
