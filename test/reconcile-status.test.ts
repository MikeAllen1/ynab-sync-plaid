import { test } from "node:test";
import assert from "node:assert/strict";
import { reconciliationSummary } from "../src/audit/reconcile";

test("reconciliation is complete only when every account has complete source and balance data", () => {
  const result = reconciliationSummary([
    { account: "checking", truncated: false, balance_check: { difference: 0 } },
    { account: "savings", truncated: false, balance_check: { difference: 0 } },
  ], 30);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.status, "complete");
});

test("truncated bank history and unavailable balance data produce a partial report", () => {
  const result = reconciliationSummary([
    { account: "checking", truncated: true, balance_check: { difference: 0 } },
    { account: "savings", truncated: false, balance_check: null },
  ], 30);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(result.summary.incomplete, 2);
});

test("one account failure makes an otherwise successful multi-account report partial", () => {
  const result = reconciliationSummary([
    { account: "checking", truncated: false, balance_check: { difference: 0 } },
    { account: "savings", error: "Plaid unavailable" },
  ], 30);
  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.summary.failed, 1);
});

test("zero selected accounts is not reported as a successful reconciliation", () => {
  const result = reconciliationSummary([], 30);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
});

test("missing balance_check field is incomplete rather than silently successful", () => {
  const result = reconciliationSummary([
    { account: "checking", truncated: false },
  ], 30);
  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.summary.incomplete, 1);
});
