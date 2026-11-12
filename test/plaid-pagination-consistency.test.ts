import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRawWindow } from "../src/plaid/fetch";
import type { Env } from "../src/types";

const env = { PLAID_ENV: "production", PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" } as Env;
const account: any = { nickname: "checking", plaid_access_token: "access", plaid_account_id: "account-1" };
const row = (id: string, amount: number) => ({
  transaction_id: id, pending_transaction_id: null, account_id: "account-1",
  date: "2026-11-10", amount, name: id, merchant_name: id, pending: false,
  personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" }
});

test("multi-page Plaid history is trusted only when two independent passes agree", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const offset = body.options.offset;
    return Response.json({ total_transactions: 2, transactions: [offset === 0 ? row("one", 1) : row("two", 2)] });
  };
  try {
    const result = await fetchRawWindow(env, account, 30, 1);
    assert.equal(result.transactions.length, 2);
    assert.equal(result.truncated, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid history is marked truncated when pages drift between verification passes", async () => {
  const originalFetch = globalThis.fetch;
  let pass = 0;
  let pages = 0;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const offset = body.options.offset;
    if (pages === 2) { pass++; pages = 0; }
    pages++;
    return Response.json({
      total_transactions: 2,
      transactions: [offset === 0 ? row("one", 1) : row("two", pass === 0 ? 2 : 3)]
    });
  };
  try {
    const result = await fetchRawWindow(env, account, 30, 1);
    assert.equal(result.transactions.length, 2);
    assert.equal(result.truncated, true, "unstable history must pause pending retirement");
  } finally { globalThis.fetch = originalFetch; }
});
