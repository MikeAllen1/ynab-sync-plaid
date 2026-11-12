import { test } from "node:test";
import assert from "node:assert/strict";
import { plaidCall } from "../src/plaid/client";
import { ynabUpsert } from "../src/ynab/client";
import type { Env } from "../src/types";

const env = {
  PLAID_ENV: "production",
  PLAID_CLIENT_ID: "plaid-client-id",
  PLAID_SECRET: "plaid-secret",
  YNAB_BUDGET_ID: "budget-123",
  YNAB_TOKEN: "ynab-secret-token",
  SYNC_LOCK: { idFromName: () => "test", get: () => ({ fetch: async () => Response.json({ reserved: true }) }) }
} as unknown as Env;

test("Plaid client sends credentials and request fields to the configured environment endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json({ accounts: [], request_id: "plaid-request" });
  };
  try {
    const result = await plaidCall(env, "/accounts/get", { access_token: "access-token" });
    assert.equal(result.request_id, "plaid-request");
    assert.equal(requestedUrl, "https://production.plaid.com/accounts/get");
    assert.equal(requestedInit?.method, "POST");
    assert.equal(new Headers(requestedInit?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      client_id: "plaid-client-id",
      secret: "plaid-secret",
      access_token: "access-token"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Plaid client surfaces provider errors instead of treating error payloads as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { error_code: "INVALID_ACCESS_TOKEN", error_message: "token revoked" },
    { status: 400 }
  );
  try {
    await assert.rejects(plaidCall(env, "/transactions/sync", { access_token: "revoked" }), /INVALID_ACCESS_TOKEN.*token revoked/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YNAB upsert uses bearer auth and strips payee_name when a transfer payee id is supplied", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json({ data: { transaction_ids: ["created-1"], duplicate_import_ids: ["duplicate-1"] } });
  };
  const transfer = {
    account_id: "ynab-checking",
    date: "2026-11-11",
    amount: -125000,
    payee_id: "payee-card",
    payee_name: "Must not be sent with payee_id",
    import_id: "wpend:plaid-1"
  };
  const ordinary = {
    account_id: "ynab-checking",
    date: "2026-11-11",
    amount: -6500,
    payee_name: "Coffee Shop",
    import_id: "wpend:plaid-2"
  };
  try {
    const result = await ynabUpsert(env, [transfer, ordinary] as any);
    assert.equal(requestedUrl, "https://api.ynab.com/v1/budgets/budget-123/transactions");
    assert.equal(requestedInit?.method, "POST");
    assert.equal(new Headers(requestedInit?.headers).get("Authorization"), "Bearer ynab-secret-token");
    const body = JSON.parse(String(requestedInit?.body));
    assert.equal(body.transactions[0].payee_id, "payee-card");
    assert.equal("payee_name" in body.transactions[0], false);
    assert.equal(body.transactions[1].payee_name, "Coffee Shop");
    assert.deepEqual(result, {
      added: 1,
      duplicates: 1,
      created_ids: ["created-1"],
      duplicate_import_ids: ["duplicate-1"]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YNAB upsert does not hide provider validation errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { error: { id: "400", name: "validation_error", detail: "invalid account" } },
    { status: 400 }
  );
  try {
    await assert.rejects(
      ynabUpsert(env, [{ account_id: "bad-account", date: "2026-11-11", amount: -1000, payee_name: "Test" }] as any),
      /YNAB upsert failed: 400/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
