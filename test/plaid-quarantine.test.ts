import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPlaidSyncDeltas } from "../src/sync/engine";
import { partitionPlaidTxns } from "../src/types";

const env: any = { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" };
const account: any = { plaid_access_token: "access", plaid_account_id: "account-1" };
const row = (id: string, extra: any = {}) => ({
  transaction_id: id, pending_transaction_id: null, account_id: "account-1", amount: 10,
  iso_currency_code: "USD", date: "2026-11-10", authorized_date: null,
  name: "Test merchant", merchant_name: "Test merchant", pending: false, ...extra
});

test("one unreadable Plaid row is set aside and the rest of the batch still syncs", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    added: [row("good-1"), row("no-currency", { iso_currency_code: null, unofficial_currency_code: "BTC" }), row("good-2")],
    modified: [], removed: [], next_cursor: "next", has_more: false
  })) as typeof fetch;
  try {
    const batch = await fetchPlaidSyncDeltas(env, account, "start");
    assert.deepEqual(batch.added.map(t => t.transaction_id), ["good-1", "good-2"]);
    assert.equal(batch.cursor, "next", "the cursor still advances past the quarantined row");
    assert.equal(batch.quarantined.length, 1);
    assert.equal(batch.quarantined[0].transaction_id, "no-currency");
    assert.match(batch.quarantined[0].reason, /ISO currency/);
  } finally { globalThis.fetch = original; }
});

test("rows beyond milliunit precision and rows missing identity are quarantined, not thrown", () => {
  const { transactions, quarantined } = partitionPlaidTxns([row("ok"), row("fine-cents", { amount: 1.0005 }), { account_id: "account-1", amount: 5 }]);
  assert.deepEqual(transactions.map(t => t.transaction_id), ["ok"]);
  assert.equal(quarantined.length, 2);
});
