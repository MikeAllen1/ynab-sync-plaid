import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleKey } from "../src/sync/engine";
import { txn } from "./helpers";

test("pending and posted Plaid records share one lifecycle identity when Plaid links them", () => {
  const pending = txn({
    transaction_id: "pending-123",
    name: "Coffee Shop",
    amount: 6.5,
    pending: true
  });
  const posted = txn({
    transaction_id: "posted-456",
    pending_transaction_id: "pending-123",
    name: "COFFEE SHOP #104",
    amount: 6.75,
    pending: false
  });

  assert.equal(lifecycleKey(pending), "pending-123");
  assert.equal(lifecycleKey(posted), "pending-123");
  assert.equal(lifecycleKey(pending), lifecycleKey(posted));
});

test("unlinked posted transactions retain their own identity", () => {
  const posted = txn({
    transaction_id: "posted-without-link",
    pending_transaction_id: null,
    name: "Grocery Store",
    amount: 42,
    pending: false
  });

  assert.equal(lifecycleKey(posted), "posted-without-link");
});

test("two otherwise identical purchases remain separate lifecycle identities", () => {
  const first = txn({
    transaction_id: "coffee-1",
    name: "Coffee Shop",
    amount: 6.5,
    date: "2026-11-11"
  });
  const second = txn({
    transaction_id: "coffee-2",
    name: "Coffee Shop",
    amount: 6.5,
    date: "2026-11-11"
  });

  assert.notEqual(lifecycleKey(first), lifecycleKey(second));
});
