import { test } from "node:test";
import assert from "node:assert/strict";
import { concurrentUpdateConflictFields, hasConcurrentDeleteConflict } from "../src/sync/engine";

const original: any = {
  id: "row-1", date: "2026-11-10", amount: -1250, payee_name: "Coffee",
  memo: "worker pending", cleared: "uncleared", approved: false,
  category_id: "category-a", flag_color: null
};

test("PATCH guard detects edits to fields the sync intends to overwrite", () => {
  const latest = { ...original, amount: -1500 };
  assert.deepEqual(concurrentUpdateConflictFields(original, latest, { id: "row-1", amount: -1250, cleared: "cleared" }), ["amount"]);
});

test("PATCH guard allows unrelated manual category and memo edits", () => {
  const latest = { ...original, category_id: "category-b", memo: "my note" };
  assert.deepEqual(concurrentUpdateConflictFields(original, latest, { id: "row-1", cleared: "cleared" }), []);
});

test("DELETE guard refuses to remove a row edited after the planning snapshot", () => {
  assert.equal(hasConcurrentDeleteConflict(original, { ...original, memo: "my note" }), true);
  assert.equal(hasConcurrentDeleteConflict(original, { ...original, cleared: "cleared" }), true);
});

test("DELETE guard allows an unchanged row", () => {
  assert.equal(hasConcurrentDeleteConflict(original, { ...original }), false);
});
