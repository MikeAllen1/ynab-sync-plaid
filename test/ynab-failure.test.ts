import { test } from "node:test";
import assert from "node:assert/strict";
import { ynabDeleteTransaction, ynabUpdateEach, ynabUpdateTransactions } from "../src/ynab/client";
import type { Env } from "../src/types";

const env = { YNAB_TOKEN: "test-token", YNAB_BUDGET_ID: "test-budget" } as Env;

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
