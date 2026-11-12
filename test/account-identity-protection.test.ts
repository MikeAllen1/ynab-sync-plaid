import { test } from "node:test";
import assert from "node:assert/strict";
import { saveAccountsMerged } from "../src/store/accounts";

function envWithAccount() {
  const values = new Map<string, string>([["account_map", JSON.stringify([{
    nickname: "checking",
    plaid_access_token: "old-token",
    plaid_account_id: "plaid-old",
    ynab_account_id: "ynab-account",
    item_id: "item-1"
  }])]]);
  return {
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); }
    }
  } as any;
}

test("account mapping permits token rotation when provider account identities are stable", async () => {
  const env = envWithAccount();
  const result = await saveAccountsMerged(env, [{
    nickname: "checking",
    plaid_access_token: "rotated-token",
    plaid_account_id: "plaid-old",
    ynab_account_id: "ynab-account",
    item_id: "item-2"
  }]);
  assert.equal(result[0].plaid_access_token, "rotated-token");
  assert.equal(result[0].plaid_account_id, "plaid-old");
  assert.equal(result[0].ynab_account_id, "ynab-account");
});

test("account mapping refuses silent Plaid account ID changes", async () => {
  await assert.rejects(
    saveAccountsMerged(envWithAccount(), [{
      nickname: "checking",
      plaid_access_token: "new-token",
      plaid_account_id: "plaid-new",
      ynab_account_id: "ynab-account"
    }]),
    /Plaid account ID changed/
  );
});

test("account mapping refuses silent YNAB destination changes", async () => {
  await assert.rejects(
    saveAccountsMerged(envWithAccount(), [{
      nickname: "checking",
      plaid_access_token: "old-token",
      plaid_account_id: "plaid-old",
      ynab_account_id: "ynab-other"
    }]),
    /YNAB destination changed/
  );
});
