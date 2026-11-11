import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccountAutomationSettings, putAccountAutomationSettings, saveAccountsMerged } from "../src/store/accounts";
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
