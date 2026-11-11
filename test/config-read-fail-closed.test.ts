import { test } from "node:test";
import assert from "node:assert/strict";
import { getSkipRules } from "../src/rules/skip-rules";
import { getPayeeAliases } from "../src/rules/payee-aliases";
import { getTransferLabels } from "../src/rules/transfer-labels";
import type { Env } from "../src/types";

function envWithGet(get: (key: string) => Promise<string | null>): Env {
  return { SYNC_STATE: { get, put: async () => {}, delete: async () => {} } } as unknown as Env;
}

test("skip rules fail closed on KV read failure or corrupt saved data", async () => {
  const unavailable = envWithGet(async () => { throw new Error("KV unavailable"); });
  await assert.rejects(() => getSkipRules(unavailable), /CONFIG_UNREADABLE/);
  for (const raw of ["{bad", JSON.stringify({ rule: "not-an-array" }), JSON.stringify([{}])]) {
    const env = envWithGet(async () => raw);
    await assert.rejects(() => getSkipRules(env), /CONFIG_UNREADABLE/);
  }
});

test("payee aliases fail closed instead of disabling configured duplicate matching", async () => {
  const unavailable = envWithGet(async () => { throw new Error("KV unavailable"); });
  await assert.rejects(() => getPayeeAliases(unavailable), /CONFIG_UNREADABLE/);
  for (const raw of ["{bad", JSON.stringify({ alias: true }), JSON.stringify([{ canonical: "Merchant", patterns: [] }])]) {
    const env = envWithGet(async () => raw);
    await assert.rejects(() => getPayeeAliases(env), /CONFIG_UNREADABLE/);
  }
});

test("transfer labels fail closed instead of guessing a transfer payee", async () => {
  const unavailable = envWithGet(async () => { throw new Error("KV unavailable"); });
  await assert.rejects(() => getTransferLabels(unavailable), /CONFIG_UNREADABLE/);
  for (const raw of ["{bad", JSON.stringify({ label: "Savings" }), JSON.stringify([{ tail: "12", label: "" }])]) {
    const env = envWithGet(async () => raw);
    await assert.rejects(() => getTransferLabels(env), /CONFIG_UNREADABLE/);
  }
});

test("missing optional rule configuration still uses safe empty or built-in defaults", async () => {
  const env = envWithGet(async () => null);
  assert.ok(Array.isArray(await getSkipRules(env)));
  assert.deepEqual(await getPayeeAliases(env), []);
  assert.deepEqual(await getTransferLabels(env), []);
});
