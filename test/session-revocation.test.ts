import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { makeTestSyncLock } from "./durable-object-fixture";
import { createAdminSessionValue } from "../src/util/http";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const origin = "https://worker.example";

async function signIn(env: Env): Promise<string> {
  const resp = await workerEntry.routeFetch(new Request(origin + "/session", { method: "POST", headers: { Origin: origin, "x-admin-token": "admin" } }), env, ctx);
  assert.equal(resp.status, 200);
  return (resp.headers.get("Set-Cookie") || "").split(";")[0];
}
const check = (env: Env, cookie: string) => workerEntry.routeFetch(new Request(origin + "/session", { headers: { Cookie: cookie } }), env, ctx);

test("signing out revokes every session, including other browsers", async () => {
  const env = { ADMIN_TOKEN: "admin", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  const laptop = await signIn(env);
  const phone = await signIn(env);
  assert.equal((await check(env, phone)).status, 200);
  const out = await workerEntry.routeFetch(new Request(origin + "/session", { method: "DELETE", headers: { Origin: origin, Cookie: laptop } }), env, ctx);
  assert.equal(((await out.json()) as any).signed_out_everywhere, true);
  assert.equal((await check(env, laptop)).status, 401);
  assert.equal((await check(env, phone)).status, 401, "a cookie copied elsewhere is dead too");
  assert.equal((await check(env, await signIn(env))).status, 200, "a fresh sign-in works");
});

test("an unauthenticated sign-out can't revoke the owner's sessions", async () => {
  const env = { ADMIN_TOKEN: "admin", SYNC_LOCK: makeTestSyncLock() } as unknown as Env;
  const mine = await signIn(env);
  const out = await workerEntry.routeFetch(new Request(origin + "/session", { method: "DELETE", headers: { Origin: origin } }), env, ctx);
  assert.equal(((await out.json()) as any).signed_out_everywhere, false);
  assert.equal((await check(env, mine)).status, 200);
});

test("a session from before an epoch bump is refused even with a valid signature", async () => {
  const env = { ADMIN_TOKEN: "admin", SYNC_LOCK: makeTestSyncLock({ admin_session_epoch: 3 }) } as unknown as Env;
  const stale = `__Host-ynab_admin=${encodeURIComponent(await createAdminSessionValue("admin", undefined, 2))}`;
  assert.equal((await check(env, stale)).status, 401);
});
