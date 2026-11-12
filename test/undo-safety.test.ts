import { test } from "node:test";
import assert from "node:assert/strict";
import { getUndoLog, rollbackSync } from "../src/sync/undo";
import { makeTestSyncLock } from "./durable-object-fixture";
import type { Env } from "../src/types";

const account = {
  nickname: "checking",
  plaid_access_token: "access-token",
  plaid_account_id: "plaid-checking",
  ynab_account_id: "ynab-checking",
  institution: "Example Bank"
};

function makeEnv(rows: any[], batchItems: any[]) {
  const batch = {
    ts: "2026-11-11T12:00:00.000Z",
    trigger: "test",
    run_id: "run-1",
    count: batchItems.length,
    items: batchItems
  };
  const values = new Map<string, string>();
  const syncLock = makeTestSyncLock({ "history:undo_log": [batch] });
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]),
    YNAB_TOKEN: "test-token",
    YNAB_BUDGET_ID: "test-budget",
    TIMEZONE: "UTC",
    SYNC_LOCK: syncLock,
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;
  return { env, values, rows };
}

test("undo never deletes reconciled or settled pending rows", async () => {
  const rows = [
    { id: "posted-worker", account_id: "ynab-checking", import_id: "YNAB:-1000:2026-11-11:1", cleared: "cleared", amount: -1000, date: "2026-11-11" },
    { id: "reconciled-worker", account_id: "ynab-checking", import_id: "YNAB:-2000:2026-11-11:1", cleared: "reconciled", amount: -2000, date: "2026-11-11" },
    { id: "settled-pending", account_id: "ynab-checking", import_id: "wpend:pending", cleared: "cleared", amount: -3000, date: "2026-11-11" }
  ];
  const { env } = makeEnv(rows, rows.map(r => ({ id: r.id, account: "checking", import_id: r.import_id })));
  const originalFetch = globalThis.fetch;
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/accounts/ynab-checking/transactions")) return Response.json({ data: { transactions: rows } });
    if (init?.method === "DELETE") { deleted.push(url.pathname.split("/").pop()!); return new Response(null, { status: 204 }); }
    throw new Error("Unexpected YNAB request " + url.pathname);
  };
  try {
    const result = await rollbackSync(env, new URL("https://worker.test/undo?confirm=true&ts=2026-11-11T12:00:00.000Z"));
    assert.equal(result.deleted, 1);
    assert.deepEqual(deleted, ["posted-worker"]);
    assert.deepEqual(result.kept.map((x: any) => [x.id, x.reason]), [
      ["reconciled-worker", "reconciled"],
      ["settled-pending", "was pending, has since posted"]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("undo retains only failed deletions so the operation can be retried safely", async () => {
  const rows = [
    { id: "delete-ok", account_id: "ynab-checking", import_id: "YNAB:-1000:2026-11-11:1", cleared: "cleared", amount: -1000, date: "2026-11-11" },
    { id: "delete-fails", account_id: "ynab-checking", import_id: "YNAB:-2000:2026-11-11:1", cleared: "cleared", amount: -2000, date: "2026-11-11" }
  ];
  const { env, values } = makeEnv(rows, rows.map(r => ({ id: r.id, account: "checking", import_id: r.import_id })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/accounts/ynab-checking/transactions")) return Response.json({ data: { transactions: rows } });
    if (init?.method === "DELETE" && url.pathname.endsWith("/delete-ok")) return new Response(null, { status: 204 });
    if (init?.method === "DELETE") return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    throw new Error("Unexpected YNAB request " + url.pathname);
  };
  try {
    const result = await rollbackSync(env, new URL("https://worker.test/undo?confirm=true&ts=2026-11-11T12:00:00.000Z"));
    assert.equal(result.deleted, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].id, "delete-fails");
    const remaining = await getUndoLog(env);
    assert.equal(remaining.length, 1);
    assert.deepEqual(remaining[0].items.map((x: any) => x.id), ["delete-fails"]);
    assert.equal(remaining[0].count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the undo preview says it only removes added rows", async () => {
  const rows = [{ id: "added", account_id: "ynab-checking", import_id: "YNAB:-1000:2026-11-11:1", cleared: "cleared", amount: -1000, date: "2026-11-11" }];
  const { env } = makeEnv(rows, rows.map(r => ({ id: r.id, account: "checking", import_id: r.import_id })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { transactions: rows } });
  try {
    const preview = await rollbackSync(env, new URL("https://worker.test/undo?index=0"));
    assert.match(preview.message, /only removes rows the sync added/);
  } finally { globalThis.fetch = originalFetch; }
});
