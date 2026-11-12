import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRawWindow } from "../src/plaid/fetch";
import type { Env, AccountConfig } from "../src/types";

const env = {
  PLAID_ENV: "production",
  PLAID_CLIENT_ID: "client",
  PLAID_SECRET: "secret"
} as unknown as Env;
const account: AccountConfig = {
  nickname: "checking",
  plaid_access_token: "access",
  plaid_account_id: "plaid-checking",
  ynab_account_id: "ynab-checking",
  institution: "Example Bank"
};

test("Plaid transaction window follows offset pagination until total_transactions is satisfied", async () => {
  const originalFetch = globalThis.fetch;
  const offsets: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const offset = body.options.offset;
    offsets.push(offset);
    const page = offset === 0
      ? [{ transaction_id: "p1", account_id: "plaid-checking", amount: 1, date: "2026-11-10", name: "A" }, { transaction_id: "p2", account_id: "plaid-checking", amount: 2, date: "2026-11-10", name: "B" }]
      : [{ transaction_id: "p3", account_id: "plaid-checking", amount: 3, date: "2026-11-10", name: "C" }];
    return Response.json({ transactions: page, total_transactions: 3 });
  };
  try {
    const result = await fetchRawWindow(env, account, 30, 2);
    assert.deepEqual(offsets, [0, 2, 0, 2], "multi-page snapshots are independently re-read before they are trusted");
    assert.deepEqual(result.transactions.map(t => t.transaction_id), ["p1", "p2", "p3"]);
    assert.equal(result.truncated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Plaid transaction window stops safely on an empty page even when provider total is inconsistent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ transactions: [], total_transactions: 100 });
  };
  try {
    const result = await fetchRawWindow(env, account, 30, 2);
    assert.equal(calls, 1);
    assert.equal(result.transactions.length, 0);
    assert.equal(result.truncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
