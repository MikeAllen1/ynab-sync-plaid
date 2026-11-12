import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { createAdminSessionValue } from "../src/util/http";
import type { Env } from "../src/types";
import { makeTestSyncLock } from "./session-fixtures";

function makeEnv() {
  return { ADMIN_TOKEN: "a-test-admin-token-with-safe-characters", SYNC_LOCK: makeTestSyncLock() } as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

test("admin session exchanges header token for a random HttpOnly cookie", async () => {
  const env = makeEnv();
  const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "POST",
    headers: { Origin: "https://worker.example", "x-admin-token": env.ADMIN_TOKEN }
  }), env, ctx);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie") || "";
  assert.match(cookie, /^__Host-ynab_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(cookie.includes(env.ADMIN_TOKEN), false);
  assert.match(decodeURIComponent(cookie.split(";")[0].split("=")[1]), /^[a-f0-9]{64}$/);
});

test("random HttpOnly session cookie authenticates without exposing the admin token", async () => {
  const env = makeEnv();
  const value = await createAdminSessionValue(env);
  const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "GET",
    headers: { Cookie: `__Host-ynab_admin=${encodeURIComponent(value)}` }
  }), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("session exchange rejects cross-origin requests and incorrect tokens", async () => {
  const env = makeEnv();
  const crossOrigin = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "x-admin-token": env.ADMIN_TOKEN }
  }), env, ctx);
  assert.equal(crossOrigin.status, 403);
  const invalid = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "POST",
    headers: { Origin: "https://worker.example", "x-admin-token": "wrong" }
  }), env, ctx);
  assert.equal(invalid.status, 401);
});

test("logout revokes the server-side session and expires the cookie", async () => {
  const env = makeEnv();
  const value = await createAdminSessionValue(env);
  const cookie = `__Host-ynab_admin=${encodeURIComponent(value)}`;
  const logout = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "DELETE", headers: { Origin: "https://worker.example", Cookie: cookie }
  }), env, ctx);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie") || "", /Max-Age=0/);
  const afterLogout = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "GET", headers: { Cookie: cookie }
  }), env, ctx);
  assert.equal(afterLogout.status, 401);
});

test("tampered admin session cookies are rejected", async () => {
  const env = makeEnv();
  const valid = await createAdminSessionValue(env);
  const tampered = valid.replace(/.$/, valid.endsWith("0") ? "1" : "0");
  const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "GET",
    headers: { Cookie: `__Host-ynab_admin=${encodeURIComponent(tampered)}` }
  }), env, ctx);
  assert.equal(response.status, 401);
});
