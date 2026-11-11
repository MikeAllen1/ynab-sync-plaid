import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const cookie = "__Host-ynab_admin=admin-test-token";

test("cookie-authenticated state changes reject cross-origin POST requests", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/skip-rules", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      Cookie: cookie,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ rules: [] })
  }), { ADMIN_TOKEN: "admin-test-token" } as Env, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "same-origin request required" });
});

test("cookie-authenticated state changes reject requests without an Origin header", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/skip-rules/reset", {
    method: "POST",
    headers: { Cookie: cookie }
  }), { ADMIN_TOKEN: "admin-test-token" } as Env, ctx);
  assert.equal(response.status, 403);
});

test("Plaid's signed webhook route remains exempt from browser Origin checks", async () => {
  // Missing Plaid signature is rejected by webhook verification, not by the
  // browser-origin guard. This keeps server-to-server Plaid delivery working.
  const response = await workerEntry.routeFetch(new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), {} as Env, ctx);
  assert.equal(response.status, 401);
});
