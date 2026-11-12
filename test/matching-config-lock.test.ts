import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { createAdminSessionValue } from "../src/util/http";
import type { Env } from "../src/types";
import { makeTestSyncLock } from "./session-fixtures";

test("matching configuration writes require the global Durable Object lock", async () => {
  const token = "test-admin-token";
  const writes: string[] = [];
  const env = {
    ADMIN_TOKEN: token,
    SYNC_LOCK: makeTestSyncLock({ failAcquire: true }),
    SYNC_STATE: {
      get: async () => null,
      put: async (key: string) => { writes.push("put:" + key); },
      delete: async (key: string) => { writes.push("delete:" + key); }
    }
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const cases = [
    ["/skip-rules", { rules: [] }],
    ["/skip-rules/reset", {}],
    ["/transfer-labels", { labels: [] }],
    ["/payee-aliases", { aliases: [] }]
  ] as const;

  for (const [path, body] of cases) {
    const response = await workerEntry.routeFetch(new Request("https://worker.example" + path, {
      method: "POST",
      headers: {
        Origin: "https://worker.example",
        Cookie: cookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }), env, ctx);
    assert.equal(response.status, 503, path + " must refuse a config write without SYNC_LOCK");
    const result = await response.json() as any;
    assert.match(result.error, /SYNC_LOCK Durable Object/);
  }
  assert.deepEqual(writes, [], "no matching configuration may be changed without the lock");
});
