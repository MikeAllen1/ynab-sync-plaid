import { test } from "node:test";
import assert from "node:assert/strict";
import { migratePlaidAccountIdentity, saveAccountsMerged } from "../src/store/accounts";

function envWithAccount() {
  const values = new Map<string, string>([["account_map", JSON.stringify([{
    nickname: "checking",
    plaid_access_token: "old-token",
    plaid_account_id: "plaid-old",
    ynab_account_id: "ynab-account",
    item_id: "item-1"
  }])], ["cursor:plaid-old", "old-cursor"]]);
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

test("explicit Plaid identity migration retains old cursor state and keeps the YNAB destination", async () => {
  const env = envWithAccount();
  const result = await migratePlaidAccountIdentity(env, "checking", "new-token", "plaid-new", "item-2", "ynab-account");
  const saved = JSON.parse((await env.SYNC_STATE.get("account_map"))!);
  assert.equal(saved[0].plaid_account_id, "plaid-new");
  assert.equal(saved[0].plaid_access_token, "new-token");
  assert.equal(saved[0].ynab_account_id, "ynab-account");
  assert.equal(await env.SYNC_STATE.get("cursor:plaid-old"), "old-cursor");
  assert.equal(await env.SYNC_STATE.get("cursor:plaid-new"), null);
  const settings = JSON.parse((await env.SYNC_STATE.get("account_automation_settings"))!);
  assert.equal(settings.find((x: any) => x.nickname === "checking").sync_enabled, false);
  const history = JSON.parse((await env.SYNC_STATE.get("account_migration:" + result.migration_id))!);
  assert.equal(history.status, "committed");
});

test("explicit Plaid identity migration refuses a new ID with existing sync state", async () => {
  const env = envWithAccount();
  await env.SYNC_STATE.put("cursor:plaid-new", "existing-cursor");
  await assert.rejects(
    migratePlaidAccountIdentity(env, "checking", "new-token", "plaid-new", "item-2", "ynab-account"),
    /already has saved sync state/
  );
  assert.equal(JSON.parse((await env.SYNC_STATE.get("account_map"))!)[0].plaid_account_id, "plaid-old");
});

test("account mapping cannot bypass migration protection by changing the nickname", async () => {
  await assert.rejects(
    saveAccountsMerged(envWithAccount(), [{
      nickname: "new-checking",
      plaid_access_token: "new-token",
      plaid_account_id: "plaid-new",
      ynab_account_id: "ynab-account"
    }]),
    /being reassigned under a different nickname/
  );
});

test("two Plaid accounts cannot be routed into the same YNAB destination", async () => {
  await assert.rejects(
    saveAccountsMerged(envWithAccount(), [
      { nickname: "checking", plaid_access_token: "old-token", plaid_account_id: "plaid-old", ynab_account_id: "ynab-account" },
      { nickname: "checking-duplicate", plaid_access_token: "new-token", plaid_account_id: "plaid-new", ynab_account_id: "ynab-account" }
    ]),
    /mapped more than once/
  );
});
