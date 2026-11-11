import { test } from "node:test";
import assert from "node:assert/strict";
import { desiredForPlaid, isCardPaymentFor } from "../src/sync/engine";
import { txn, checking, visa, amex, ctx } from "./helpers";

test("a pending purchase becomes an uncleared row right away", () => {
  const d = desiredForPlaid(txn({ name: "Corner Cafe", merchant_name: "Corner Cafe", amount: 6.5, pending: true, pfc_primary: "FOOD_AND_DRINK" }), checking, [], ctx());
  assert.deepEqual(d.row && { a: d.row.amount, c: d.row.cleared, p: d.row.payee_name, m: d.row.memo, acct: d.row.account_id }, { a: -6500, c: "uncleared", p: "Corner Cafe", m: "Pending", acct: "ynab-checking" });
});

test("a posted refund is a cleared inflow", () => {
  const d = desiredForPlaid(txn({ name: "Corner Cafe", merchant_name: "Corner Cafe", amount: -6.5 }), checking, [], ctx());
  assert.equal(d.row?.amount, 6500);
  assert.equal(d.row?.cleared, "cleared");
});

test("a skip rule is checked before anything else", () => {
  const d = desiredForPlaid(txn({ name: "ACME PAYROLL", amount: -2500, pfc_primary: "INCOME" }), checking,
    [{ id: "r", enabled: true, account: "*", contains: "ACME", transaction_type: "inflow", reason: "entered by hand" }], ctx());
  assert.equal(d.skipKind, "rule");
});

test("paying a tracked card from checking becomes a YNAB transfer to that card", () => {
  const pay = txn({ name: "CHASE SAPPHIRE AUTOPAY", amount: 300, pfc_primary: "LOAN_PAYMENTS", pfc_detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
  const d = desiredForPlaid(pay, checking, [], ctx());
  assert.equal(d.row?.payee_id, "payee-visa");
  assert.equal(d.row?.amount, -300000);
  // While pending: booked now, uncleared.
  const p = desiredForPlaid({ ...pay, pending: true }, checking, [], ctx());
  assert.equal(p.row?.payee_id, "payee-visa");
  assert.equal(p.row?.cleared, "uncleared");
});

test("the card's own 'payment thank you' is skipped: the transfer already covers it", () => {
  const thanks = txn({ name: "AUTOMATIC PAYMENT - THANK YOU", amount: -300, account_id: "acct-visa" });
  assert.ok(isCardPaymentFor(visa, thanks));
  assert.equal(desiredForPlaid(thanks, visa, [], ctx()).skipKind, "card_side");
  // A purchase on the card is never a payment.
  assert.ok(!isCardPaymentFor(visa, txn({ name: "NINTENDO PAYMENT CARD", amount: 59.99, pfc_primary: "ENTERTAINMENT" })));
});

test("card payments before the cutoff stay inside the card's starting balance", () => {
  const pay = txn({ name: "AMEX EPAYMENT ACH PMT", amount: 500, date: "2026-01-02" });
  assert.equal(desiredForPlaid(pay, checking, [], ctx({ cutoff: "2026-02-01" })).skipKind, "cutoff");
  assert.equal(desiredForPlaid(pay, checking, [], ctx({ cutoff: "2026-01-01" })).row?.payee_id, "payee-amex");
});

test("if the card's YNAB transfer payee can't be read, a pending payment waits instead of booking a plain outflow", () => {
  const pay = txn({ name: "AMEX EPAYMENT ACH PMT", amount: 500, pending: true });
  const d = desiredForPlaid(pay, checking, [], ctx({ cardPayeeByNickname: {} }));
  assert.equal(d.skipKind, "pending_card_payment");
  void amex;
});
