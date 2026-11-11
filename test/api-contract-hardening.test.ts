import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlaidTxn } from "../src/types";
import { CARD_SIDE_PAYMENT_RE } from "../src/sync/engine";
import { resolveCardForPayment } from "../src/sync/transfers";

const base = {
  transaction_id: "plaid-tx",
  pending_transaction_id: null,
  account_id: "plaid-account",
  amount: 12.34,
  iso_currency_code: "USD",
  date: "2026-11-11",
  authorized_date: null,
  name: "Coffee Shop",
  merchant_name: "Coffee Shop",
  pending: false
};

test("Plaid normalization preserves the supplied ISO currency and amount", () => {
  const txn = normalizePlaidTxn(base);
  assert.equal(txn.iso_currency_code, "USD");
  assert.equal(txn.amount, 12.34);
});

test("Plaid normalization rejects a missing ISO currency instead of assuming USD", () => {
  assert.throws(
    () => normalizePlaidTxn({ ...base, iso_currency_code: null, unofficial_currency_code: "BTC" }),
    /no supported ISO currency code/
  );
});

test("Plaid normalization rejects amounts that cannot be represented in YNAB milliunits", () => {
  assert.throws(
    () => normalizePlaidTxn({ ...base, amount: 1.2345 }),
    /exceeds YNAB milliunit precision/
  );
});

test("card-side text classifier requires explicit payment-received evidence", () => {
  assert.equal(CARD_SIDE_PAYMENT_RE.test("AUTOPAY"), false);
  assert.equal(CARD_SIDE_PAYMENT_RE.test("ONLINE PAYMENT"), false);
  assert.equal(CARD_SIDE_PAYMENT_RE.test("MOBILE PAYMENT - THANK YOU"), true);
  assert.equal(CARD_SIDE_PAYMENT_RE.test("PAYMENT RECEIVED"), true);
});

test("ambiguous payment matching never selects the first configured card", () => {
  const accounts: any[] = [
    { nickname: "card-a", is_credit_card: true, payment_match: { last4: ["1234"], words: ["visa"] } },
    { nickname: "card-b", is_credit_card: true, payment_match: { last4: ["1234"], words: ["visa"] } }
  ];
  const txn: any = { ...base, name: "ONLINE PAYMENT VISA 1234", amount: 250 };
  assert.equal(resolveCardForPayment(txn, accounts, []), null);
});
