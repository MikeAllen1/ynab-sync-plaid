import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlaidTxn } from "../src/types";
import { CARD_SIDE_PAYMENT_RE, contentMatch, lifecycleKey } from "../src/sync/engine";
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

test("posted transactions retain the pending lifecycle identity when Plaid supplies the link", () => {
  const posted: any = { ...base, transaction_id: "posted-id", pending_transaction_id: "pending-id", pending: false };
  assert.equal(lifecycleKey(posted), "pending-id");
});

test("identical same-day purchases retain separate lifecycle identities", () => {
  const first: any = { ...base, transaction_id: "coffee-1", amount: 5.25 };
  const second: any = { ...base, transaction_id: "coffee-2", amount: 5.25 };
  assert.notEqual(lifecycleKey(first), lifecycleKey(second));
});

test("posted transactions without a pending link use their own identity, never a guessed match", () => {
  const posted: any = { ...base, transaction_id: "posted-without-link", pending_transaction_id: null, pending: false };
  assert.equal(lifecycleKey(posted), "posted-without-link");
});

test("equally close content candidates are rejected instead of depending on register order", () => {
  const txn: any = { ...base, transaction_id: "new-charge", amount: 8.5, date: "2026-11-11" };
  const spec: any = { row: { amount: -8500, payee_name: "Coffee Shop" } };
  const candidates: any[] = [
    { id: "row-a", amount: -8500, date: "2026-11-11", payee_name: "Coffee Shop" },
    { id: "row-b", amount: -8500, date: "2026-11-11", payee_name: "Coffee Shop" }
  ];
  assert.equal(contentMatch(txn, spec, candidates, () => true, []), null);
});
