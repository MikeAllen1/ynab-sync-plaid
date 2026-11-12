import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueAmountPairs } from "../src/sync/engine";
import { txn } from "./helpers";
import type { YNABExistingTransaction } from "../src/types";

const row = (o: Partial<YNABExistingTransaction>): YNABExistingTransaction =>
  ({ id: "row-1", account_id: "ynab-checking", date: "2026-03-10", amount: -40000, payee_name: "", cleared: "uncleared", import_id: null, transfer_transaction_id: null, ...o } as YNABExistingTransaction);
const pairs = (t: any, r: YNABExistingTransaction) =>
  uniqueAmountPairs([{ t }], [r], () => true, []);

test("a same-amount row with an uninformative name days away is not taken for the charge", () => {
  // You typed "Gas $40" on Monday; the bank's $40 SHELL OIL is Thursday.
  const charge = txn({ name: "SHELL OIL 57444", merchant_name: "Shell", amount: 40, date: "2026-03-12" });
  assert.equal(pairs(charge, row({ payee_name: "Gas", date: "2026-03-09" })).length, 0);
});

test("the same uninformative row a day away still pairs", () => {
  const charge = txn({ name: "SHELL OIL 57444", merchant_name: "Shell", amount: 40, date: "2026-03-10" });
  assert.equal(pairs(charge, row({ payee_name: "Gas", date: "2026-03-11" })).length, 1);
});

test("names that agree still pair across the normal date window", () => {
  const charge = txn({ name: "SHELL OIL 57444", merchant_name: "Shell Oil", amount: 40, date: "2026-03-12" });
  assert.equal(pairs(charge, row({ payee_name: "Shell Oil", date: "2026-03-09" })).length, 1);
});
