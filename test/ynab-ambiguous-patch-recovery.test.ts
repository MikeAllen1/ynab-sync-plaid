import { test } from "node:test";
import assert from "node:assert/strict";
import { ynabUpdateEach } from "../src/ynab/client";
import { makeTestSyncLock } from "./durable-object-fixture";
import type { Env } from "../src/types";

function makeEnv(): Env {
  return {
    YNAB_TOKEN: "test-token",
    YNAB_BUDGET_ID: "test-budget",
    SYNC_LOCK: makeTestSyncLock()
  } as Env;
}

function installYnabMock(rows: Map<string, any>, mode: "partial" | "committed") {
  const originalFetch = globalThis.fetch;
  let patchCalls = 0;
  let readCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method || "GET";
    if (method === "GET") {
      readCalls++;
      const id = url.pathname.split("/").pop()!;
      return Response.json({ data: { transaction: rows.get(id) || null } });
    }
    patchCalls++;
    const updates = JSON.parse(String(init?.body || "{}")).transactions || [];
    for (const update of updates) {
      if (mode === "committed" || updates.length === 1) {
        const row = rows.get(update.id);
        if (row) Object.assign(row, update);
      } else if (updates.length > 1 && update.id === "row-a") {
        const row = rows.get(update.id);
        if (row) Object.assign(row, update);
      }
    }
    if (updates.length > 1) {
      return new Response(JSON.stringify({ error: { detail: "gateway failed after partial batch commit" } }), { status: 503 });
    }
    return Response.json({ data: { transaction_ids: updates.map((x: any) => x.id) } });
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    get patchCalls() { return patchCalls; },
    get readCalls() { return readCalls; }
  };
}

test("ambiguous partially committed YNAB PATCH reads rows back and patches only unresolved rows", async () => {
  const rows = new Map([
    ["row-a", { id: "row-a", cleared: "cleared" }],
    ["row-b", { id: "row-b", cleared: "uncleared" }]
  ]);
  const mock = installYnabMock(rows, "partial");
  try {
    const result = await ynabUpdateEach(makeEnv(), [
      { id: "row-a", cleared: "cleared" },
      { id: "row-b", cleared: "cleared" }
    ]);
    assert.deepEqual(result, { updated: 2, failed: [] });
    assert.equal(mock.patchCalls, 2, "one ambiguous batch plus one unresolved-row PATCH");
    assert.equal(mock.readCalls, 2, "both rows are read back before any retry");
    assert.equal(rows.get("row-a")?.cleared, "cleared");
    assert.equal(rows.get("row-b")?.cleared, "cleared");
  } finally {
    mock.restore();
  }
});

test("YNAB PATCH committed before a lost response is recovered without replay", async () => {
  const rows = new Map([
    ["row-a", { id: "row-a", cleared: "uncleared" }],
    ["row-b", { id: "row-b", cleared: "uncleared" }]
  ]);
  const mock = installYnabMock(rows, "committed");
  try {
    const result = await ynabUpdateEach(makeEnv(), [
      { id: "row-a", cleared: "cleared" },
      { id: "row-b", cleared: "cleared" }
    ]);
    assert.deepEqual(result, { updated: 2, failed: [] });
    assert.equal(mock.patchCalls, 1, "the ambiguous committed PATCH is never replayed");
    assert.equal(mock.readCalls, 2, "both rows are verified by read-back");
    assert.equal(rows.get("row-a")?.cleared, "cleared");
    assert.equal(rows.get("row-b")?.cleared, "cleared");
  } finally {
    mock.restore();
  }
});
