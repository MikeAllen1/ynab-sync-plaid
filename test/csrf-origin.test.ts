import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { createAdminSessionValue } from "../src/util/http";
import type { Env } from "../src/types";
import { makeTestSyncLock } from "./session-fixtures";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const env = { ADMIN_TOKEN: "admin-test-token", SYNC_LOCK: makeTestSyncLock() } as Env;

test("state-changing routes cannot be invoked with GET", async () => {
  const cookie = `__Host-ynab_admin=${encodeURIComponent(await createAdminSessionValue(env))}`;
  const paths = [
    "/audit/accounts",
    "/sync",
    "/force-refresh",
    "/configure-webhooks",
    "/bootstrap?account=checking",
    "/reset-card?account=checking",
    "/pause",
    "/resume",
    "/test-alert",
    "/skip-rules/reset",
    "/undo?confirm=true",
    "/backfill-recent?dryRun=false"
  ];
  for (const path of paths) {
    const response = await workerEntry.routeFetch(new Request("https://worker.example" + path, {
      method: "GET",
      headers: { Cookie: cookie }
    }), env, ctx);
    assert.equal(response.status, 405, path + " must reject GET");
  }
});

test("cookie-authenticated state changes reject cross-origin POST requests", async () => {
  const cookie = `__Host-ynab_admin=${encodeURIComponent(await createAdminSessionValue("admin-test-token"))}`;
  const response = await workerEntry.routeFetch(new Request("https://worker.example/skip-rules", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      Cookie: cookie,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ rules: [] })
  }), env, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "same-origin request required" });
});

test("cookie-authenticated state changes reject requests without an Origin header", async () => {
  const cookie = `__Host-ynab_admin=${encodeURIComponent(await createAdminSessionValue("admin-test-token"))}`;
  const response = await workerEntry.routeFetch(new Request("https://worker.example/skip-rules/reset", {
    method: "POST",
    headers: { Cookie: cookie }
  }), env, ctx);
  assert.equal(response.status, 403);
});

test("Plaid's signed webhook route remains exempt from browser Origin checks", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), {} as Env, ctx);
  assert.equal(response.status, 401);
});
