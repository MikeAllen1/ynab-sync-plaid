import { test } from "node:test";
import assert from "node:assert/strict";
import { debugPlaidRawTransactions } from "../src/plaid/fetch";
import type { Env } from "../src/types";

test("Plaid debug failures never disclose access-token material", async () => {
  const secret = "access-sandbox-secret-token-value";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error_code: "INVALID_ACCESS_TOKEN",
    error_message: "The access token is invalid"
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  try {
    const env = {
      PLAID_ENV: "sandbox",
      PLAID_CLIENT_ID: "client-id",
      PLAID_SECRET: "plaid-secret",
      SYNC_STATE: {
        get: async (key: string) => key === "account_map" ? JSON.stringify([{
          nickname: "checking",
          plaid_access_token: secret,
          plaid_account_id: "plaid-account-id",
          ynab_account_id: "ynab-account-id"
        }]) : null
      }
    } as unknown as Env;
    const result = await debugPlaidRawTransactions(env, new URL("https://worker.example/debug/plaid/raw?account=checking"));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("plaid_access_token_preview"), false);
    assert.match(serialized, /INVALID_ACCESS_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
