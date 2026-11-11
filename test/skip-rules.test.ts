import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSkipRule, matchingSkipRule, normalizeSkipRule } from "../src/rules/skip-rules";
import { txn, checking, savings } from "./helpers";
import type { SkipRule } from "../src/types";

const rule = (o: Partial<SkipRule>): SkipRule => ({ id: "r1", enabled: true, account: "*", contains: "ACME", transaction_type: "any", reason: "entered by hand", ...o });

test("a rule matches by text, direction, account and (optionally) exact amount", () => {
  const pay = txn({ name: "ACME CORP PAYROLL", amount: -2500 });
  assert.ok(matchesSkipRule(pay, checking, rule({})));
  assert.ok(matchesSkipRule(pay, checking, rule({ transaction_type: "inflow" })));
  assert.ok(!matchesSkipRule(pay, checking, rule({ transaction_type: "outflow" })));
  assert.ok(!matchesSkipRule(pay, savings, rule({ account: "checking" })));
  assert.ok(matchesSkipRule(pay, checking, rule({ amounts: [2500] })));
  assert.ok(!matchesSkipRule(pay, checking, rule({ amounts: [2400] })));
  assert.ok(!matchesSkipRule(pay, checking, rule({ enabled: false })));
  assert.ok(!matchesSkipRule(pay, checking, rule({ contains: "  " })));
});

test("the first matching rule wins", () => {
  const r = matchingSkipRule(txn({ name: "ACME", amount: 1 }), checking, [rule({ id: "a", contains: "NOPE" }), rule({ id: "b" }), rule({ id: "c" })]);
  assert.equal(r?.id, "b");
});

test("saved rules are cleaned up when read", () => {
  assert.equal(normalizeSkipRule(null), null);
  const r = normalizeSkipRule({ id: "x", contains: " acme ", transaction_type: "bogus", account: "" });
  assert.ok(r);
});
