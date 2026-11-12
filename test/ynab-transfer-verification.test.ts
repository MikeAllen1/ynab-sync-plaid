import { test } from "node:test";
import assert from "node:assert/strict";
import { ynabVerifyTransferPair } from "../src/ynab/client";

const env: any = {
  YNAB_BUDGET_ID: "plan-id",
  YNAB_TOKEN: "token",
  SYNC_LOCK: {
    idFromName: () => "global",
    get: () => ({ fetch: async () => Response.json({ reserved: true }) })
  }
};
const transaction = (id: string, account: string, amount: number, paired: string, target: string) => ({
  id, account_id: account, amount, transfer_transaction_id: paired, transfer_account_id: target
});

test("YNAB transfer verification requires reciprocal pair, intended accounts, and opposite amounts", async () => {
  const original = globalThis.fetch;
  const rows = [
    transaction("source", "checking", -125000, "target", "card"),
    transaction("target", "card", 125000, "source", "checking")
  ];
  let index = 0;
  globalThis.fetch = (async () => Response.json({ data: { transaction: rows[index++] } })) as typeof fetch;
  try {
    await ynabVerifyTransferPair(env, "source", "checking", "card", -125000);
    assert.equal(index, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("YNAB transfer verification rejects a mismatched destination", async () => {
  const original = globalThis.fetch;
  const rows = [
    transaction("source", "checking", -125000, "target", "wrong-card")
  ];
  let index = 0;
  globalThis.fetch = (async () => Response.json({ data: { transaction: rows[index++] } })) as typeof fetch;
  try {
    await assert.rejects(ynabVerifyTransferPair(env, "source", "checking", "card", -125000), /not paired to the expected account/);
  } finally {
    globalThis.fetch = original;
  }
});
