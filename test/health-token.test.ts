import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
const env = { ADMIN_TOKEN: "admin-token", HEALTH_TOKEN: "health-token", SYNC_STATE: kv } as unknown as Env;

test("the read-only health token reads only the monitor summary", async () => {
  const resp = await workerEntry.fetch(new Request("https://worker.example/health", { headers: { "x-health-token": "health-token" } }), env, ctx);
  assert.equal(resp.status, 200);
  const body: any = await resp.json();
  assert.deepEqual(Object.keys(body).sort(), ["health_status", "lock_mode", "ok", "overdue_accounts", "sync_enabled"]);
});

test("the health token can't be used for anything else", async () => {
  for (const [path, method] of [["/accounts", "GET"], ["/events", "GET"], ["/pause", "POST"]] as const) {
    const resp = await workerEntry.fetch(new Request("https://worker.example" + path, {
      method, headers: { "x-health-token": "health-token", Origin: "https://worker.example" }
    }), env, ctx);
    assert.equal(resp.status, 401, path);
  }
});

test("a wrong health token is refused", async () => {
  const resp = await workerEntry.fetch(new Request("https://worker.example/health", { headers: { "x-health-token": "nope" } }), env, ctx);
  assert.equal(resp.status, 401);
});

test("a health token equal to the admin token is refused as a misconfiguration", async () => {
  const same = { ...env, HEALTH_TOKEN: "admin-token" } as Env;
  const resp = await workerEntry.fetch(new Request("https://worker.example/health", { headers: { "x-health-token": "admin-token" } }), same, ctx);
  assert.equal(resp.status, 500);
});
