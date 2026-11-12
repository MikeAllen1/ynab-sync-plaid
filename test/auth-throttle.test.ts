import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { makeTestSyncLock } from "./durable-object-fixture";
import { AUTH_FAILS_PER_IP } from "../src/lock/sync-lock-do";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const session = (env: Env, token: string, ip = "203.0.113.7") => workerEntry.routeFetch(new Request("https://worker.example/session", {
  method: "POST", headers: { Origin: "https://worker.example", "x-admin-token": token, "CF-Connecting-IP": ip }
}), env, ctx);

test("repeated wrong admin tokens from one address are throttled", async () => {
  const env = { ADMIN_TOKEN: "right", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  for (let i = 0; i < AUTH_FAILS_PER_IP - 1; i++) assert.equal((await session(env, "wrong")).status, 401);
  const limited = await session(env, "wrong");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  // Even the right token waits out the window from that address...
  assert.equal((await session(env, "right")).status, 429);
  // ...but another address is unaffected.
  assert.equal((await session(env, "right", "198.51.100.9")).status, 200);
});

test("header-token API calls share the same throttle", async () => {
  const env = { ADMIN_TOKEN: "right", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  const call = (token: string) => workerEntry.routeFetch(new Request("https://worker.example/events", {
    headers: { "x-admin-token": token, "CF-Connecting-IP": "203.0.113.8" }
  }), env, ctx);
  for (let i = 0; i < AUTH_FAILS_PER_IP - 1; i++) assert.equal((await call("wrong")).status, 401);
  assert.equal((await call("wrong")).status, 429);
});

test("without the Durable Object, sign-in still works (never locks the owner out)", async () => {
  const env = { ADMIN_TOKEN: "right" } as unknown as Env;
  assert.equal((await session(env, "wrong")).status, 401);
  assert.equal((await session(env, "right")).status, 200);
});
