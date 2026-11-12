import { test } from "node:test";
import assert from "node:assert/strict";
import { ynabDeleteTransaction, ynabUpdateEach, ynabUpdateTransactions, ynabUpsert } from "../src/ynab/client";
import type { Env } from "../src/types";

const env = { YNAB_TOKEN: "test-token", YNAB_BUDGET_ID: "test-budget", SYNC_LOCK: { idFromName: () => "test", get: () => ({ fetch: async () => Response.json({ reserved: true }) }) } } as Env;

test("a refused YNAB update batch is retried per row and reports only the failed row", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const ids = (body.transactions || []).map((x: any) => x.id);
    calls.push(ids.join(","));
    if (ids.length > 1) return Response.json({ error: { detail: "batch rejected" } }, { status: 400 });
    if (ids[0] === "row-good") return Response.json({ data: { transaction_ids: ["row-good"] } });
    return Response.json({ error: { detail: "row cannot be changed" } }, { status: 400 });
  };
  try {
    const result = await ynabUpdateEach(env, [
      { id: "row-good", cleared: "cleared" },
      { id: "row-bad", cleared: "cleared" }
    ]);
    assert.equal(result.updated, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, "row-bad");
    assert.deepEqual(calls, ["row-good,row-bad", "row-good", "row-bad"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("YNAB delete treats 404 as already deleted but surfaces service failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 404 });
    assert.deepEqual(await ynabDeleteTransaction(env, "already-gone"), { already_deleted: true });
    globalThis.fetch = async () => Response.json({ error: "temporarily unavailable" }, { status: 503 });
    await assert.rejects(ynabDeleteTransaction(env, "retry-later"), /YNAB transaction delete failed: 503/);
  } finally { globalThis.fetch = originalFetch; }
});

test("YNAB malformed 2xx update response is not reported as a successful zero-row update", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: {} });
  try {
    await assert.rejects(
      ynabUpdateTransactions(env, [{ id: "row-1", cleared: "cleared" }]),
      /invalid success response.*transaction_ids/
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("ambiguous YNAB transfer create is safely recovered by the same import id", async () => {
  const originalFetch = globalThis.fetch;
  const sourceRows = new Map<string, any>();
  const pairedRows = new Map<string, any>();
  let first = true;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const transactions = body.transactions || [];
    for (const row of transactions) {
      if (sourceRows.has(row.import_id)) continue;
      sourceRows.set(row.import_id, { ...row, id: "source-" + sourceRows.size });
      if (row.payee_id) pairedRows.set(row.import_id, { id: "paired-" + pairedRows.size, transfer_transaction_id: "source-" + (sourceRows.size - 1) });
    }
    if (first) { first = false; throw new Error("connection reset after transfer pair commit"); }
    const duplicates = transactions.filter((row: any) => sourceRows.has(row.import_id)).map((row: any) => row.import_id);
    return Response.json({ data: { transaction_ids: [], duplicate_import_ids: duplicates } });
  };
  const row = {
    account_id: "checking", date: "2026-11-11", amount: -125000,
    payee_id: "transfer-payee-card", import_id: "wpend:payment-123"
  };
  try {
    await assert.rejects(ynabUpsert(env, [row]), /connection reset after transfer pair commit/);
    assert.equal(sourceRows.size, 1);
    assert.equal(pairedRows.size, 1);
    const recovered = await ynabUpsert(env, [row]);
    assert.equal(recovered.duplicates, 1);
    assert.equal(sourceRows.size, 1, "replay must not duplicate the source transfer leg");
    assert.equal(pairedRows.size, 1, "replay must not duplicate the paired card leg");
  } finally { globalThis.fetch = originalFetch; }
});

test("ambiguous YNAB update is retried by state reconciliation without duplicate mutation", async () => {
  const originalFetch = globalThis.fetch;
  const row = { id: "existing-row", cleared: "cleared" };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    row.cleared = "cleared";
    if (calls === 1) throw new Error("connection reset after update commit");
    return Response.json({ data: { transaction_ids: ["existing-row"] } });
  };
  try {
    await assert.rejects(ynabUpdateTransactions(env, [{ id: "existing-row", cleared: "cleared" }]), /connection reset/);
    const result = await ynabUpdateTransactions(env, [{ id: "existing-row", cleared: "cleared" }]);
    assert.equal(result.updated, 1);
    assert.equal(row.cleared, "cleared");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("ambiguous YNAB delete is safely retried after confirming the row is gone", async () => {
  const originalFetch = globalThis.fetch;
  let exists = true;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (!exists) return new Response("", { status: 404 });
    exists = false;
    throw new Error("connection reset after delete commit");
  };
  try {
    await assert.rejects(ynabDeleteTransaction(env, "row-to-delete"), /connection reset/);
    assert.deepEqual(await ynabDeleteTransaction(env, "row-to-delete"), { already_deleted: true });
    assert.equal(exists, false);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("partially committed YNAB update batch is read back and only unresolved rows are patched", async () => {
  const originalFetch = globalThis.fetch;
  const rows = new Map([
    ["row-a", { id: "row-a", cleared: "uncleared" }],
    ["row-b", { id: "row-b", cleared: "uncleared" }]
  ]);
  let batchCalls = 0;
  let singleCalls = 0;
  let getCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "GET") {
      getCalls++;
      const id = url.pathname.split("/").pop()!;
      return Response.json({ data: { transaction: rows.get(id) } });
    }
    const updates = JSON.parse(String(init?.body || "{}")).transactions || [];
    if (updates.length > 1) {
      batchCalls++;
      rows.set(updates[0].id, { ...rows.get(updates[0].id)!, ...updates[0] });
      return Response.json({ error: { detail: "gateway failed after partial batch commit" } }, { status: 503 });
    }
    singleCalls++;
    rows.set(updates[0].id, { ...rows.get(updates[0].id)!, ...updates[0] });
    return Response.json({ data: { transaction_ids: [updates[0].id] } });
  };
  try {
    const result = await ynabUpdateEach(env, [
      { id: "row-a", cleared: "cleared" },
      { id: "row-b", cleared: "cleared" }
    ]);
    assert.equal(batchCalls, 1);
    assert.equal(getCalls, 2);
    assert.equal(singleCalls, 1);
    assert.equal(result.updated, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(rows.get("row-a")?.cleared, "cleared");
    assert.equal(rows.get("row-b")?.cleared, "cleared");
  } finally { globalThis.fetch = originalFetch; }
});

test("a YNAB update committed before a lost response is recovered by read-back without replay", async () => {
  const originalFetch = globalThis.fetch;
  const rows = new Map([
    ["row-a", { id: "row-a", cleared: "uncleared" }],
    ["row-b", { id: "row-b", cleared: "uncleared" }]
  ]);
  let patchCalls = 0;
  let getCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "GET") {
      getCalls++;
      const id = url.pathname.split("/").pop()!;
      return Response.json({ data: { transaction: rows.get(id) } });
    }
    patchCalls++;
    const body = JSON.parse(String(init?.body || "{}"));
    for (const patch of body.transactions || []) {
      const row = rows.get(patch.id);
      if (row) Object.assign(row, patch);
    }
    if (patchCalls === 1) throw new Error("connection reset after YNAB committed the batch");
    return Response.json({ data: { transaction_ids: (body.transactions || []).map((x: any) => x.id) } });
  };
  try {
    const result = await ynabUpdateEach(env, [
      { id: "row-a", cleared: "cleared" },
      { id: "row-b", cleared: "cleared" }
    ]);
    assert.equal(result.updated, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(rows.get("row-a")?.cleared, "cleared");
    assert.equal(rows.get("row-b")?.cleared, "cleared");
    assert.equal(patchCalls, 1);
    assert.equal(getCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
