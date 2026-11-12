import { test } from "node:test";
import assert from "node:assert/strict";
import { syncAccountEngine } from "../src/sync/engine";
import { resetRunCache } from "../src/plaid/fetch";
import type { Env } from "../src/types";

test("full sync lifecycle converts one pending charge to posted in the same YNAB row", async () => {
  const account = {
    nickname: "checking",
    plaid_access_token: "plaid-access",
    plaid_account_id: "plaid-checking",
    ynab_account_id: "ynab-checking",
    institution: "Example Bank"
  };
  const state = new Map<string, string>([["cursor:plaid-checking", "cursor-start"]]);
  const ynabRows: any[] = [];
  const pending = {
    transaction_id: "plaid-pending-1",
    pending_transaction_id: null,
    account_id: "plaid-checking",
    amount: 6.5,
    iso_currency_code: "USD",
    date: "2026-11-10",
    authorized_date: "2026-11-10",
    name: "Coffee Shop",
    merchant_name: "Coffee Shop",
    pending: true,
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }
  };
  const posted = {
    ...pending,
    transaction_id: "plaid-posted-1",
    pending_transaction_id: "plaid-pending-1",
    amount: 6.75,
    date: "2026-11-11",
    pending: false
  };
  let phase: "pending" | "posted" = "pending";
  const syncCursors: string[] = [];
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]),
    PLAID_ENV: "production",
    PLAID_CLIENT_ID: "plaid-client",
    PLAID_SECRET: "plaid-secret",
    YNAB_TOKEN: "ynab-token",
    YNAB_BUDGET_ID: "budget-id",
    TIMEZONE: "UTC",
    SYNC_STATE: {
      get: async (key: string) => state.get(key) ?? null,
      put: async (key: string, value: string) => { state.set(key, value); },
      delete: async (key: string) => { state.delete(key); }
    }
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "production.plaid.com") {
      if (url.pathname === "/transactions/sync") {
        const body = JSON.parse(String(init?.body || "{}"));
        syncCursors.push(String(body.cursor || ""));
        if (phase === "pending" && body.cursor === "cursor-start") {
          return Response.json({ added: [pending], modified: [], removed: [], next_cursor: "cursor-page-1", has_more: true });
        }
        if (phase === "pending" && body.cursor === "cursor-page-1") {
          return Response.json({ added: [], modified: [], removed: [], next_cursor: "cursor-pending", has_more: false });
        }
        if (phase === "posted" && body.cursor === "cursor-pending") {
          return Response.json({ added: [], modified: [posted], removed: [], next_cursor: "cursor-posted", has_more: false });
        }
        return Response.json({ added: [], modified: [], removed: [], next_cursor: body.cursor || "cursor-posted", has_more: false });
      }
      if (url.pathname === "/transactions/get") {
        return Response.json({ transactions: [phase === "pending" ? pending : posted], total_transactions: 1 });
      }
      if (url.pathname === "/accounts/get") {
        return Response.json({ accounts: [{ account_id: "plaid-checking", mask: "1234" }] });
      }
      throw new Error("Unexpected Plaid endpoint " + url.pathname);
    }
    if (url.hostname === "api.ynab.com") {
      if (url.pathname.endsWith("/accounts")) {
        return Response.json({ data: { accounts: [{ id: "ynab-checking", name: "Checking", type: "checking", closed: false, deleted: false }] } });
      }
      if (url.pathname.endsWith("/accounts/ynab-checking/transactions")) {
        return Response.json({ data: { transactions: ynabRows } });
      }
      if (url.pathname.endsWith("/transactions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}"));
        const ids: string[] = [];
        for (const row of body.transactions || []) {
          const id = "ynab-row-" + (ynabRows.length + 1);
          ynabRows.push({
            id, account_id: row.account_id, date: row.date, amount: row.amount,
            payee_name: row.payee_name, cleared: row.cleared, memo: row.memo,
            import_id: row.import_id, transfer_transaction_id: null
          });
          ids.push(id);
        }
        return Response.json({ data: { transaction_ids: ids, duplicate_import_ids: [] } });
      }
      if (url.pathname.endsWith("/transactions") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body || "{}"));
        const ids: string[] = [];
        for (const patch of body.transactions || []) {
          const row = ynabRows.find(r => r.id === patch.id);
          if (!row) continue;
          Object.assign(row, patch);
          ids.push(row.id);
        }
        return Response.json({ data: { transaction_ids: ids } });
      }
      throw new Error("Unexpected YNAB endpoint " + url.pathname + " " + init?.method);
    }
    throw new Error("Unexpected host " + url.hostname);
  };

  try {
    resetRunCache();
    const first = await syncAccountEngine(env, account, [], { trigger: "lifecycle-pending", runId: "lifecycle-1" });
    assert.equal(first.status, "ok");
    assert.equal(ynabRows.length, 1);
    const originalRowId = ynabRows[0].id;
    assert.equal(ynabRows[0].cleared, "uncleared");
    assert.equal(ynabRows[0].amount, -6500);
    assert.equal(ynabRows[0].memo, "Pending");
    assert.deepEqual(syncCursors.slice(0, 2), ["cursor-start", "cursor-page-1"], "all Plaid sync pages must be fetched before the cursor is committed");

    phase = "posted";
    resetRunCache();
    const second = await syncAccountEngine(env, account, [], { trigger: "lifecycle-posted", runId: "lifecycle-2" });
    assert.equal(second.status, "ok");
    assert.equal(ynabRows.length, 1, "posted replacement must not create a second YNAB row");
    assert.equal(ynabRows[0].id, originalRowId, "the pending row must be updated in place");
    assert.equal(ynabRows[0].cleared, "cleared");
    assert.equal(ynabRows[0].amount, -6750);
    assert.equal(ynabRows[0].memo, null);
    assert.equal(state.get("cursor:plaid-checking"), "cursor-posted");
    assert.equal(syncCursors[2], "cursor-pending");

    resetRunCache();
    const third = await syncAccountEngine(env, account, [], { trigger: "lifecycle-repeat", runId: "lifecycle-3" });
    assert.equal(third.status, "ok");
    assert.equal(ynabRows.length, 1, "repeated sync must remain idempotent");
  } finally {
    globalThis.fetch = originalFetch;
    resetRunCache();
  }
});
