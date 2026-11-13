import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { makeTestSyncLock } from "./durable-object-fixture";
import { AUTH_FAILS_PER_IP } from "../src/lock/sync-lock-do";
import { clientAddressKey } from "../src/util/http";
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

test("wrong guesses from many addresses never lock the owner out", async () => {
  // Was a global bucket: 50 failures from rotating addresses made the correct token
  // answer 429 for 15 minutes, everywhere, and an attacker could keep it that way.
  const env = { ADMIN_TOKEN: "right", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  for (let i = 0; i < 120; i++) await session(env, "wrong", `198.51.100.${i % 250}`);
  assert.equal((await session(env, "right", "203.0.113.200")).status, 200);
  const script = await workerEntry.routeFetch(new Request("https://worker.example/events", {
    headers: { "x-admin-token": "right", "CF-Connecting-IP": "203.0.113.201" }
  }), env, ctx);
  assert.notEqual(script.status, 429);
});

test("IPv6 attempts are counted per /64, so rotating the host part doesn't reset the limit", async () => {
  const env = { ADMIN_TOKEN: "right", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  for (let i = 0; i < AUTH_FAILS_PER_IP; i++) await session(env, "wrong", `2001:db8:1:2::${(i + 1).toString(16)}`);
  assert.equal((await session(env, "wrong", "2001:db8:1:2:ffff::9")).status, 429);
  assert.equal((await session(env, "right", "2001:db8:1:3::1")).status, 200, "a different /64 is unaffected");
});

test("address keys: IPv4, IPv4-mapped IPv6, compressed IPv6", () => {
  assert.equal(clientAddressKey("203.0.113.7"), "ip:203.0.113.7");
  assert.equal(clientAddressKey("::ffff:203.0.113.7"), "ip:203.0.113.7");
  assert.equal(clientAddressKey("2001:DB8:0:0001::1"), "ip6:2001:db8:0:1");
  assert.equal(clientAddressKey("2001:db8::"), "ip6:2001:db8:0:0");
  assert.equal(clientAddressKey(null), "ip:unknown");
});
