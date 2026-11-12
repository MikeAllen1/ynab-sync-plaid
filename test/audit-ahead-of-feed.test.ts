import { test } from "node:test";
import assert from "node:assert/strict";
import { auditAccount } from "../src/audit/audit";
import { todayInTimeZone } from "../src/util/dates";
import { checking, ctx } from "./helpers";

// You enter today's $2.50 charge (from your bank's app) and reconcile; the bank feed
// hasn't delivered it yet. That is YNAB being ahead of the feed, not a mystery gap.
test("a charge entered in YNAB today that the bank feed hasn't delivered yet isn't an unexplained difference", async () => {
  const store: Record<string, string> = {};
  const env: any = {
    PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret", YNAB_TOKEN: "t", YNAB_BUDGET_ID: "b",
    TIMEZONE: "America/Chicago",
    SYNC_STATE: { get: async (k: string) => store[k] ?? null, put: async (k: string, v: string) => { store[k] = v; }, delete: async (k: string) => { delete store[k]; }, list: async () => ({ keys: [], list_complete: true }) },
  };
  const today = todayInTimeZone(env);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/transactions/get")) return new Response(JSON.stringify({ transactions: [], total_transactions: 0, accounts: [] }), { status: 200 });
    if (u.endsWith("/item/get")) return new Response(JSON.stringify({ item: { item_id: "i" }, status: {} }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  try {
    const lotto = { id: "row-lotto", date: today, amount: -2500, cleared: "reconciled", approved: true, payee_name: "Pos Debit Lotto.Com", import_id: null, transfer_account_id: null, memo: null, subtransactions: [] };
    const audit: any = await auditAccount(
      env, checking, 7, 7, [checking],
      { [checking.ynab_account_id]: [lotto] as any },
      { [checking.ynab_account_id]: { balance: -2500, cleared_balance: -2500, uncleared_balance: 0 } as any },
      [], ctx({ accounts: [checking] }), [],
      async () => ({ accounts: [{ account_id: checking.plaid_account_id, balances: { current: 0, available: 0 } }] }),
    );
    const text = [...(audit.warnings || []), ...(audit.notes || [])].join(" | ");
    assert.doesNotMatch(text, /Reconciling in YNAB will be off/, text);
    assert.match(text, /not in the bank feed yet/, text);
  } finally {
    globalThis.fetch = realFetch;
  }
});
