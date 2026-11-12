import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccountAutomationSettings, getAccounts, maskToken, putAccountAutomationSettings, saveAccountsMerged } from "../src/store/accounts";
import type { Env } from "../src/types";

function mockEnv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
  return { env: { SYNC_STATE: kv } as unknown as Env, values };
}

const accountMap = JSON.stringify([
  { nickname: "checking", plaid_access_token: "access-token", plaid_account_id: "plaid-checking", ynab_account_id: "ynab-checking" },
  { nickname: "savings", plaid_access_token: "access-token", plaid_account_id: "plaid-savings", ynab_account_id: "ynab-savings" },
]);

test("partial automation update refuses malformed persisted JSON without overwriting it", async () => {
  const { env, values } = mockEnv({ account_map: accountMap, account_automation_settings: "{bad json" });
  await assert.rejects(
    () => putAccountAutomationSettings(env, [{ nickname: "checking", sync_frequency_minutes: 30 }]),
    /CONFIG_UNREADABLE/
  );
  assert.equal(values.get("account_automation_settings"), "{bad json");
});

test("partial automation update refuses a non-array persisted value", async () => {
  const corrupt = JSON.stringify({ checking: { sync_enabled: false } });
  const { env, values } = mockEnv({ account_map: accountMap, account_automation_settings: corrupt });
  await assert.rejects(
    () => putAccountAutomationSettings(env, [{ nickname: "checking", sync_frequency_minutes: 30 }]),
    /CONFIG_UNREADABLE/
  );
  assert.equal(values.get("account_automation_settings"), corrupt);
});

test("settings reject non-boolean values instead of interpreting them as enabled", async () => {
  for (const invalid of ["false", null, 0, {}]) {
    const { env } = mockEnv({ account_map: accountMap });
    await assert.rejects(
      () => putAccountAutomationSettings(env, [{ nickname: "checking", sync_enabled: invalid }]),
      /sync_enabled must be a boolean/
    );
  }
});

test("saved non-boolean settings fail closed when read", async () => {
  const { env } = mockEnv({
    account_map: accountMap,
    account_automation_settings: JSON.stringify([{ nickname: "checking", sync_enabled: "false" }]),
  });
  await assert.rejects(() => getAccountAutomationSettings(env), /CONFIG_UNREADABLE/);
});

test("valid partial update preserves an explicitly disabled account", async () => {
  const { env, values } = mockEnv({
    account_map: accountMap,
    account_automation_settings: JSON.stringify([
      { nickname: "checking", sync_enabled: false, backfill_enabled: false, audit_enabled: true, sync_frequency_minutes: 15 },
      { nickname: "savings", sync_enabled: false, backfill_enabled: false, audit_enabled: true, sync_frequency_minutes: 15 },
    ]),
  });
  const updated = await putAccountAutomationSettings(env, [{ nickname: "checking", sync_frequency_minutes: 30 }]);
  assert.equal(updated.find(s => s.nickname === "checking")?.sync_enabled, false);
  assert.equal(updated.find(s => s.nickname === "savings")?.sync_enabled, false);
  assert.ok(values.get("account_automation_settings"));
});

test("account nickname whitespace is normalized consistently before persistence", async () => {
  const { env, values } = mockEnv({ account_map: accountMap });
  const saved = await saveAccountsMerged(env, [{
    nickname: "  Checking   Account  ",
    plaid_access_token: "new-access-token",
    plaid_account_id: "plaid-new-account",
    ynab_account_id: "ynab-new-account",
    is_credit_card: false
  }]);
  assert.equal(saved[0].nickname, "checking-account");
  const persisted = JSON.parse(values.get("account_map") || "[]");
  assert.equal(persisted[0].nickname, "checking-account");
  assert.ok(!persisted[0].nickname.includes(" "));
});

test("account store read failure does not fall back to a potentially stale environment seed", async () => {
  const env = {
    ACCOUNT_MAP: accountMap,
    SYNC_STATE: {
      get: async () => { throw new Error("simulated KV outage"); },
      put: async () => {},
      delete: async () => {}
    }
  } as unknown as Env;
  await assert.rejects(
    () => import("../src/store/accounts").then(m => m.getAccounts(env)),
    /SYNC_STATE is unavailable.*No account sync was performed/
  );
});

test("persisted account maps fail closed when an entry is incomplete or duplicated", async () => {
  const invalidMaps = [
    [{ nickname: "checking", plaid_account_id: "plaid-checking", ynab_account_id: "ynab-checking" }],
    [
      { nickname: "checking", plaid_access_token: "token-a", plaid_account_id: "same-id", ynab_account_id: "ynab-a" },
      { nickname: "savings", plaid_access_token: "token-b", plaid_account_id: "same-id", ynab_account_id: "ynab-b" }
    ],
    [{ nickname: "checking", plaid_access_token: "token", plaid_account_id: "plaid-checking", ynab_account_id: "ynab-checking", is_credit_card: "false" }]
  ];
  for (const accounts of invalidMaps) {
    const { env } = mockEnv({ account_map: JSON.stringify(accounts) });
    await assert.rejects(() => getAccounts(env), /CONFIG_UNREADABLE/);
  }
});

test("valid persisted account maps normalize nicknames consistently", async () => {
  const { env } = mockEnv({
    account_map: JSON.stringify([{
      nickname: "  Checking   Account ",
      plaid_access_token: " token ",
      plaid_account_id: " plaid-checking ",
      ynab_account_id: " ynab-checking "
    }])
  });
  const accounts = await getAccounts(env);
  assert.equal(accounts[0].nickname, "checking-account");
  assert.equal(accounts[0].plaid_access_token, "token");
  assert.equal(accounts[0].plaid_account_id, "plaid-checking");
  assert.equal(accounts[0].ynab_account_id, "ynab-checking");
});


test("token display helper never reveals credential characters", () => {
  assert.equal(maskToken("access-token-with-sensitive-prefix"), "••••••••");
  assert.equal(maskToken(undefined), "");
});

test("saved settings still apply when the stored nickname differs only by case (\"Amex\" vs \"amex\")", async () => {
  const { settingForAccount, saveAccountConfiguration } = await import("../src/store/accounts");
  const tok = "access-production-00000000-0000-0000-0000-000000000004";
  const store: Record<string, string> = {
    account_map: JSON.stringify([{ nickname: "Amex", institution: "", plaid_access_token: tok, plaid_account_id: "DDD4", ynab_account_id: "y4", item_id: "item4", is_credit_card: true }]),
    account_automation_settings: JSON.stringify([{ nickname: "Amex", sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 120, audit_enabled: true }]),
    "bootstrapped:DDD4": "1",
    "cursor:DDD4": "cursor-from-the-old-worker",
  };
  const env = { SYNC_STATE: {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v; },
    delete: async (k: string) => { delete store[k]; },
  } } as unknown as Env;

  const [acct] = await getAccounts(env);
  assert.equal(acct.nickname, "amex");
  const settings = await getAccountAutomationSettings(env);
  assert.equal(settings[0].sync_enabled, true, "the saved 'Amex' setting must apply to account 'amex'");
  assert.equal(settings[0].sync_frequency_minutes, 120);
  assert.equal(settingForAccount([{ nickname: "Amex", sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 120, audit_enabled: true }], acct).sync_enabled, true);

  // Saving it unchanged from the dashboard must not look like "turned back on", which
  // would throw away the account's sync position and re-bootstrap it.
  await saveAccountConfiguration(env, [{ nickname: "amex", plaid_account_id: "DDD4", ynab_account_id: "y4", is_credit_card: true }], [{ nickname: "amex", sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 120, audit_enabled: true }]);
  assert.equal(store["cursor:DDD4"], "cursor-from-the-old-worker");
  assert.equal(store["bootstrapped:DDD4"], "1");
});
