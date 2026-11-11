import { test } from "node:test";
import assert from "node:assert/strict";
import { debugPlaidRawTransactions } from "../src/plaid/fetch";
import type { Env } from "../src/types";

test("Plaid debug failures never disclose access-token material", async () => {
  const secret = "access-sandbox-secret-token-value";
  const env = {
    SYNC_STATE: {
      get: async () => JSON.stringify([{
        nickname: "checking",
        plaid_access_token: secret,
        plaid_account_id: "plaid-account-id",
        ynab_account_id: "ynab-account-id"
      }])
    }
  } as unknown as Env;
  // This test exercises the formatting contract independently of a live Plaid call.
  // A malformed account store must not be allowed to return credential fields.
  const result = await debugPlaidRawTransactions(env, new URL("https://worker.example/debug/plaid/raw?account=missing"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("plaid_access_token_preview"), false);
});
