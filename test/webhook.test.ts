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
