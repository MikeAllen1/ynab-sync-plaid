import { test } from "node:test";
import assert from "node:assert/strict";
import { syncAccountEngine } from "../src/sync/engine";
import { resetRunCache } from "../src/plaid/fetch";
import type { Env } from "../src/types";

test("a lost YNAB create response leaves cursor unchanged and next run recovers the committed row", async () => {
  const account = {
    nickname: "checking",
    plaid_access_token: "plaid-access",
    plaid_account_id: "plaid-checking",
    ynab_account_id: "ynab-checking",
    institution: "Example Bank"
  };
  const values = new Map<string, string>([
    ["cursor:plaid-checking", "cursor-start"],
    ["sync:enabled", "true"]
  ]);
  const ynabRows: any[] = [];
  let failAfterCommit = true;
  let failCursorCommit = false;
  let malformedSyncPage = false;
  const originalFetch = globalThis.fetch;
  const env = {
    ACCOUNT_MAP: JSON.stringify([account]),
    PLAID_ENV: "production",
    PLAID_CLIENT_ID: "plaid-client",
    PLAID_SECRET: "plaid-secret",
    YNAB_TOKEN: "ynab-token",
    YNAB_BUDGET_ID: "budget-id",
    TIMEZONE: "America/Chicago",
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        if (key === "cursor:plaid-checking" && failCursorCommit) {
          failCursorCommit = false;
          throw new Error("simulated KV cursor commit failure");
        }
        values.set(key, value);
      },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "production.plaid.com") {
      const body = JSON.parse(String(init?.body || "{}"));
      if (url.pathname === "/transactions/sync") {
        if (malformedSyncPage) return Response.json({ added: [], modified: [], removed: [], next_cursor: "cursor-bad", has_more: "false" });
        const second = body.cursor === "cursor-next";
        return Response.json({
          added: [{
            transaction_id: second ? "plaid-tx-2" : "plaid-tx-1", pending_transaction_id: null,
            account_id: "plaid-checking", amount: second ? 8.75 : 6.5, iso_currency_code: "USD",
            date: second ? "2026-11-11" : "2026-11-10", authorized_date: null,
            name: second ? "Book Store" : "Coffee Shop",
            merchant_name: second ? "Book Store" : "Coffee Shop", pending: false,
            personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_BOOKSTORES" }
          }],
          modified: [], removed: [], next_cursor: second ? "cursor-third" : "cursor-next", has_more: false
        });
      }
      if (url.pathname === "/accounts/get") {
        return Response.json({ accounts: [{ account_id: "plaid-checking", mask: "1234" }] });
      }
      if (url.pathname === "/transactions/get") {
        return Response.json({ transactions: [], total_transactions: 0 });
      }
      throw new Error("Unexpected Plaid endpoint: " + url.pathname + " " + JSON.stringify(body));
    }

    if (url.hostname === "api.ynab.com") {
      if (url.pathname.endsWith("/accounts")) {
        return Response.json({ data: { accounts: [{
          id: "ynab-checking", name: "Checking", type: "checking",
          closed: false, deleted: false
        }] } });
      }
      if (url.pathname.endsWith("/accounts/ynab-checking/transactions")) {
        return Response.json({ data: { transactions: ynabRows } });
      }
      if (url.pathname.endsWith("/transactions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}"));
        for (const row of body.transactions || []) {
          ynabRows.push({
            id: "ynab-created-" + (ynabRows.length + 1), account_id: row.account_id, date: row.date,
            amount: row.amount, payee_name: row.payee_name || "Coffee Shop",
            cleared: row.cleared, import_id: row.import_id,
            transfer_transaction_id: null
          });
        }
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("simulated connection reset after YNAB committed the create");
        }
        return Response.json({ data: { transaction_ids: ["ynab-created-1"], duplicate_import_ids: [] } });
      }
      throw new Error("Unexpected YNAB endpoint: " + url.pathname);
    }
    throw new Error("Unexpected host: " + url.hostname);
  };

  try {
    resetRunCache();
    await assert.rejects(
      syncAccountEngine(env, account, [], { trigger: "fault-injection", runId: "run-fault-1" }),
      /simulated connection reset/
    );

    assert.equal(values.get("cursor:plaid-checking"), "cursor-start", "cursor must not advance after an ambiguous create result");
    const intent = JSON.parse(values.get("undo_intent:plaid-checking") || "null");
    assert.ok(Array.isArray(intent?.import_ids) && intent.import_ids.length === 1, "pre-write undo intent must survive the interrupted run");
    assert.equal(ynabRows.length, 1, "the simulated YNAB side effect must have committed");

    resetRunCache();
    const recovered = await syncAccountEngine(env, account, [], { trigger: "fault-recovery", runId: "run-fault-2" });
    assert.equal(recovered.status, "ok");
    assert.equal(values.get("cursor:plaid-checking"), "cursor-next", "cursor advances only after the committed row is recovered");
    assert.equal(values.has("undo_intent:plaid-checking"), false, "recovered intent is cleared");
    const undo = JSON.parse(values.get("undo_log") || "[]");
    assert.ok(undo.some((batch: any) => batch.items?.some((item: any) => item.id === "ynab-created-1")), "the committed row must be recorded for undo");
    assert.equal(ynabRows.length, 1, "recovery must not create a duplicate");

    // A later run successfully writes another row, then KV rejects the cursor
    // commit. Replaying that Plaid page must match the existing import id.
    failCursorCommit = true;
    resetRunCache();
    await assert.rejects(
      syncAccountEngine(env, account, [], { trigger: "cursor-fault", runId: "run-fault-3" }),
      /simulated KV cursor commit failure/
    );
    assert.equal(values.get("cursor:plaid-checking"), "cursor-next");
    assert.equal(ynabRows.length, 2, "the second YNAB create committed before the cursor failure");

    resetRunCache();
    const cursorRecovered = await syncAccountEngine(env, account, [], { trigger: "cursor-recovery", runId: "run-fault-4" });
    assert.equal(cursorRecovered.status, "ok");
    assert.equal(values.get("cursor:plaid-checking"), "cursor-third");

    assert.equal(ynabRows.length, 2, "replaying after cursor persistence failure must not duplicate the row");

    malformedSyncPage = true;
    resetRunCache();
    await assert.rejects(
      syncAccountEngine(env, account, [], { trigger: "malformed-page", runId: "run-fault-5" }),
      /Plaid \/transactions\/sync returned an invalid page/
    );
    assert.equal(values.get("cursor:plaid-checking"), "cursor-third", "malformed pagination metadata must never advance the saved cursor");
  } finally {
    globalThis.fetch = originalFetch;
    resetRunCache();
  }
});
