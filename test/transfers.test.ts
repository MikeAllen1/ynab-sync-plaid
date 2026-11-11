import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTransfer, transferPayeeName, zellePersonName, paymentTextMatches, resolveCardForPayment, untrackedCardPayee } from "../src/sync/transfers";
import { normalizeTransferLabel } from "../src/rules/transfer-labels";
import { txn, checking, savings, visa, amex } from "./helpers";

test("credit card payments are recognized by category or by issuer + payment words", () => {
  assert.equal(classifyTransfer(txn({ name: "Payment to card", amount: 250, pfc_primary: "LOAN_PAYMENTS", pfc_detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" })), "card_payment");
  assert.equal(classifyTransfer(txn({ name: "AMEX EPAYMENT ACH PMT", amount: 250, pfc_primary: "GENERAL_SERVICES" })), "card_payment");
});

test("a mortgage or car payment is never a card payment", () => {
  assert.equal(classifyTransfer(txn({ name: "MR COOPER MORTGAGE PAYMENT", amount: 1800, pfc_primary: "LOAN_PAYMENTS", pfc_detailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" })), "outflow_track");
  assert.equal(classifyTransfer(txn({ name: "AUTO LOAN PMT", amount: 400, pfc_primary: "LOAN_PAYMENTS", pfc_detailed: "LOAN_PAYMENTS_CAR_PAYMENT" })), "outflow_track");
});

test("an issuer's name on a purchase isn't a payment", () => {
  assert.equal(classifyTransfer(txn({ name: "AMERICAN EXPRESS TRAVEL", amount: 120, pfc_primary: "TRAVEL" })), null);
  // "CARDINAL" contains CARD, but whole words only.
  assert.equal(classifyTransfer(txn({ name: "CARDINAL HEALTH PAYMENT", amount: 30, pfc_primary: "MEDICAL" })), null);
});

test("paychecks and incoming transfers are spendable; outgoing transfers are tracked spending", () => {
  assert.equal(classifyTransfer(txn({ name: "ACME CORP PAYROLL", amount: -2500, pfc_primary: "INCOME" })), "spendable_in");
  assert.equal(classifyTransfer(txn({ name: "Transfer to savings", amount: 200, pfc_primary: "TRANSFER_OUT" })), "outflow_track");
  assert.equal(classifyTransfer(txn({ name: "PAYPAL INST XFER", amount: 45, pfc_primary: "TRANSFER_OUT", pfc_detailed: "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS" })), "outflow_track");
  assert.equal(classifyTransfer(txn({ name: "Corner Cafe", amount: 6.5, pfc_primary: "FOOD_AND_DRINK" })), null);
});

test("transfer payees are stable names, including your labelled accounts", () => {
  const labels = [normalizeTransferLabel({ tail: "...5678", label: "Kids' account", in: "Back from kids' account" })!];
  assert.equal(transferPayeeName(txn({ name: "ONLINE TRANSFER TO XXXXXX5678 REF 88123", amount: 50 }), "outflow_track", labels), "Kids' account");
  assert.equal(transferPayeeName(txn({ name: "ONLINE TRANSFER FROM XXXXXX5678 REF 1", amount: -50 }), "spendable_in", labels), "Back from kids' account");
  assert.equal(transferPayeeName(txn({ name: "ONLINE TRANSFER TO XXXXXX9999", amount: 50 }), "outflow_track", labels), "Transfer Out");
  assert.equal(transferPayeeName(txn({ name: "ROBINHOOD DEBITS", amount: 100 }), "outflow_track"), "Robinhood");
  assert.equal(transferPayeeName(txn({ name: "Zelle payment to JANE Q DOE JPM99A1", amount: 40 }), "outflow_track"), "Zelle to Jane Doe");
  assert.equal(transferPayeeName(txn({ name: "ACME DIRECT DEP", amount: -2000 }), "spendable_in"), "Payroll");
});

test("transfer labels need 3+ digits and a name", () => {
  assert.equal(normalizeTransferLabel({ tail: "12", label: "x" }), null);
  assert.equal(normalizeTransferLabel({ tail: "1234", label: " " }), null);
  assert.deepEqual(normalizeTransferLabel({ tail: "acct 001234", label: "Savings" }), { tail: "1234", label: "Savings" });
});

test("Zelle names: first and last, skipping a middle initial and reference codes", () => {
  assert.equal(zellePersonName("Zelle payment from JOHN A SMITH 8XY2", "FROM"), "John Smith");
  assert.equal(zellePersonName("Zelle payment to MARY JPM12", "TO"), "Mary");
});

test("a card's last 4 counts only as its own number, not inside a trace number", () => {
  const t = (name: string) => txn({ name, amount: 100 });
  assert.ok(paymentTextMatches(t("AUTOPAY 4321"), ["4321"], []));
  assert.ok(!paymentTextMatches(t("ACH 021000043211234"), ["4321"], []));
  assert.ok(paymentTextMatches(t("CHASE SAPPHIRE EPAY"), [], ["sapphire"]));
});

test("a payment goes to the card it names; words beat a coincidental number", () => {
  const accts = [checking, savings, visa, amex];
  assert.equal(resolveCardForPayment(txn({ name: "PAYMENT TO CARD ENDING IN 4321", amount: 300 }), accts, [])?.nickname, "rewards-card");
  assert.equal(resolveCardForPayment(txn({ name: "AMERICAN EXPRESS ACH PMT 4321", amount: 300 }), accts, [])?.nickname, "amex");
  // Names the issuer only: the one Chase card.
  assert.equal(resolveCardForPayment(txn({ name: "CHASE CREDIT CRD EPAY", amount: 300 }), accts, [])?.nickname, "rewards-card");
  // Names a card number that isn't one of yours: not your card.
  assert.equal(resolveCardForPayment(txn({ name: "PAYMENT TO CHASE CARD ENDING IN 4455", amount: 300 }), accts, []), null);
});

test("payments to cards you don't track get a readable payee", () => {
  assert.equal(untrackedCardPayee(txn({ name: "AMEX EPAYMENT", amount: 50 })), "American Express");
  assert.equal(untrackedCardPayee(txn({ name: "CRCARDPMT", amount: 50 })), "Credit Card Payment");
});
