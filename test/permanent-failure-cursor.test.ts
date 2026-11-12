import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedPendingImportId, syncAccountEngine } from "../src/sync/engine";
import { resetRunCache, shiftCalendarDate } from "../src/plaid/fetch";
import { todayInTimeZone } from "../src/util/dates";
import { makeTestSyncLock } from "./durable-object-fixture";
import type { Env } from "../src/types";

const account = { nickname: "checking", plaid_access_token: "plaid-access", plaid_account_id: "plaid-checking", ynab_account_id: "ynab-checking", institution: "Example Bank" };

async function runWithRefusedUpdate(firstFailedDaysAgo: number) {
  const env0 = { TIMEZONE: "America/Chicago" } as unknown as Env;
  const today = todayInTimeZone(env0);
  const values = new Map<string, string>([
    ["cursor:plaid-checking", "cursor-start"],
    ["sync:enabled", "true"],
    ["update_failed:plaid-checking", JSON.stringify({ "ynab-row-1": shiftCalendarDate(today, -firstFailedDaysAgo) })]
  ]);
  const posted = {
    transaction_id: "post-1", pending_transaction_id: "pend-1", account_id: "plaid-checking", amount: 6.5,
    iso_currency_code: "USD", date: shiftCalendarDate(today, -1), authorized_date: null,
    name: "Coffee Shop", merchant_name: "Coffee Shop", pending: false,
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }
  };
  const ynabRows = [{
    id: "ynab-row-1", account_id: "ynab-checking", date: shiftCalendarDate(today, -2), amount: -6500,
    payee_name: "Coffee Shop", cleared: "uncleared", memo: "Pending",
    import_id: expectedPendingImportId(account, "pend-1", ""), transfer_transaction_id: null, deleted: false
  }];
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]), PLAID_ENV: "production", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s",
    YNAB_TOKEN: "y", YNAB_BUDGET_ID: "budget-id", TIMEZONE: "America/Chicago", SYNC_LOCK: makeTestSyncLock(),
    SYNC_STATE: {
      get: async (k: string) => values.get(k) ?? null,
      put: async (k: string, v: string) => { values.set(k, v); },
      delete: async (k: string) => { values.delete(k); }
    }
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "production.plaid.com") {
      if (url.pathname === "/transactions/sync") return Response.json({ added: [posted], modified: [], removed: [{ account_id: "plaid-checking", transaction_id: "pend-1" }], next_cursor: "cursor-next", has_more: false });
      if (url.pathname === "/accounts/get") return Response.json({ accounts: [{ account_id: "plaid-checking", mask: "1234" }] });
      if (url.pathname === "/transactions/get") return Response.json({ transactions: [posted], total_transactions: 1 });
    }
    if (url.hostname === "api.ynab.com") {
      if (url.pathname.endsWith("/settings")) return Response.json({ data: { settings: { currency_format: { iso_code: "USD" } } } });
      if (url.pathname.endsWith("/accounts")) return Response.json({ data: { accounts: [{ id: "ynab-checking", name: "Checking", type: "checking", closed: false, deleted: false }] } });
      if (url.pathname.endsWith("/accounts/ynab-checking/transactions")) return Response.json({ data: { transactions: ynabRows } });
      if (init?.method === "PATCH") return Response.json({ error: { id: "400", name: "bad_request", detail: "split rows can't be changed" } }, { status: 400 });
    }
    throw new Error("Unexpected request: " + url.href);
  };
  try {
    resetRunCache();
    const result = await syncAccountEngine(env, account, [], { trigger: "test", runId: "run-1" });
    return { result, cursor: values.get("cursor:plaid-checking"), failed: JSON.parse(values.get("update_failed:plaid-checking") || "{}") };
  } finally { globalThis.fetch = originalFetch; resetRunCache(); }
}

test("a fresh YNAB refusal holds the bank cursor so the change is replayed", async () => {
  const { result, cursor } = await runWithRefusedUpdate(0);
  assert.equal(result.status, "partial");
  assert.equal(cursor, "cursor-start");
});

test("a YNAB refusal that has lasted days no longer pins the bank cursor", async () => {
  const { result, cursor, failed } = await runWithRefusedUpdate(4);
  assert.equal(result.status, "partial", "still reported, still under Needs you");
  assert.equal(cursor, "cursor-next", "new bank activity is no longer held back");
  assert.match(failed["ynab-row-1"], /#released$/);
});
