import { test } from "node:test";
import assert from "node:assert/strict";
import { ynabUpdateTransactions } from "../src/ynab/client";

const env = { YNAB_BUDGET_ID: "budget", YNAB_TOKEN: "token", SYNC_LOCK: { idFromName: () => "test", get: () => ({ fetch: async () => Response.json({ reserved: true }) }) } } as any;
const updates = [{ id: "tx-1", cleared: "cleared" }, { id: "tx-2", cleared: "cleared" }];

test("YNAB update response confirms every requested transaction", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { transaction_ids: ["tx-1", "tx-2"] } });
  try {
    assert.deepEqual(await ynabUpdateTransactions(env, updates), { updated: 2 });
  } finally { globalThis.fetch = originalFetch; }
});

test("YNAB update response missing transaction_ids is not treated as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: {} });
  try {
    await assert.rejects(() => ynabUpdateTransactions(env, updates), /invalid transaction result envelope/);
  } finally { globalThis.fetch = originalFetch; }
});

test("YNAB update response confirming only part of a batch is not treated as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { transaction_ids: ["tx-1"] } });
  try {
    await assert.rejects(() => ynabUpdateTransactions(env, updates), /did not confirm 1 of 2/);
  } finally { globalThis.fetch = originalFetch; }
});
