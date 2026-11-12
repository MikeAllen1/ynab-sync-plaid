import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRawWindow, shiftCalendarDate } from "../src/plaid/fetch";

const env: any = { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" };
const account: any = { plaid_access_token: "access", plaid_account_id: "account-1" };
const row = (id: string, accountId = "account-1") => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: accountId,
  amount: 10,
  iso_currency_code: "USD",
  date: "2026-11-10",
  authorized_date: null,
  name: "Test merchant",
  merchant_name: "Test merchant",
  pending: false
});
const response = (transactions: any[], total: number) =>
  new Response(JSON.stringify({ transactions, total_transactions: total }), { status: 200 });

test("calendar windows shift date-only values without host timezone dependence", () => {
  assert.equal(shiftCalendarDate("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftCalendarDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftCalendarDate("2024-03-01", -1), "2024-02-29");
  assert.throws(() => shiftCalendarDate("not-a-date", -1), /Invalid calendar date shift/);
});

test("Plaid transaction snapshot paginates all rows with a stable total", async () => {
  const original = globalThis.fetch;
  const pages = [response([row("a"), row("b")], 3), response([row("c")], 3)];
  let calls = 0;
  globalThis.fetch = (async () => pages[calls++]) as typeof fetch;
  try {
    const result = await fetchRawWindow(env, account, 30, 2);
    assert.equal(calls, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.transactions.map(t => t.transaction_id), ["a", "b", "c"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Plaid snapshot fails closed when the reported total changes between pages", async () => {
  const original = globalThis.fetch;
  const pages = [response([row("a"), row("b")], 3), response([row("c")], 4)];
  let calls = 0;
  globalThis.fetch = (async () => pages[calls++]) as typeof fetch;
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 2), /total_transactions changed/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Plaid snapshot rejects repeated transaction IDs across pages", async () => {
  const original = globalThis.fetch;
  const pages = [response([row("a"), row("b")], 3), response([row("b")], 3)];
  let calls = 0;
  globalThis.fetch = (async () => pages[calls++]) as typeof fetch;
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 2), /repeated a transaction/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Plaid snapshot rejects transactions returned for a different account", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response([row("a", "wrong-account")], 1)) as typeof fetch;
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 2), /unexpected account/);
  } finally {
    globalThis.fetch = original;
  }
});
