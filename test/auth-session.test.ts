import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import type { Env } from "../src/types";

function makeEnv() {
  return { ADMIN_TOKEN: "a-test-admin-token-with-safe-characters" } as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

test("admin session exchanges header token for a short-lived HttpOnly cookie", async () => {
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
  assert.equal(cookie.includes(env.ADMIN_TOKEN), true);
});

test("HttpOnly session cookie authenticates requests without a JavaScript-readable token", async () => {
  const env = makeEnv();
  const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "GET",
    headers: { Cookie: `__Host-ynab_admin=${encodeURIComponent(`v1.${Math.floor(Date.now() / 1000)}.${env.ADMIN_TOKEN}`)}` }
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

test("logout expires the HttpOnly session cookie", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
    method: "DELETE", headers: { Origin: "https://worker.example" }
  }), makeEnv(), ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie") || "", /Max-Age=0/);
});

test("expired or future-dated admin session cookies are rejected server-side", async () => {
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  for (const issuedAt of [now - 3601, now + 60]) {
    const response = await workerEntry.routeFetch(new Request("https://worker.example/session", {
      method: "GET",
      headers: { Cookie: `__Host-ynab_admin=${encodeURIComponent(`v1.${issuedAt}.${env.ADMIN_TOKEN}`)}` }
    }), env, ctx);
    assert.equal(response.status, 401);
  }
});
