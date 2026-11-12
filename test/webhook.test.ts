import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import type { Env } from "../src/types";

test("webhook endpoint rejects oversized request bodies before verification", async () => {
  const body = "x".repeat(1024 * 1024 + 1);
  const req = new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const env = {} as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const response = await workerEntry.routeFetch(req, env, ctx);
  assert.equal(response.status, 413);
});


test("webhook route rejects unsigned requests before history writes or sync scheduling", async () => {
  const req = new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" })
  });
  let scheduled = 0;
  const env = {
    SYNC_STATE: {
      get: async () => null,
      put: async () => { throw new Error("unverified webhook must not write history"); },
      delete: async () => { throw new Error("unverified webhook must not delete state"); }
    }
  } as unknown as Env;
  const ctx = {
    waitUntil: () => { scheduled++; },
    passThroughOnException: () => {}
  } as unknown as ExecutionContext;
  const response = await workerEntry.routeFetch(req, env, ctx);
  assert.equal(response.status, 401);
  assert.equal(scheduled, 0);
  assert.match((await response.json() as any).error, /verification failed/);
});
