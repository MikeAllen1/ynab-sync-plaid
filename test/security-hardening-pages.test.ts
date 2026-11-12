import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";
import { makeTestSyncLock } from "./session-fixtures";
import type { Env } from "../src/types";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function pageEnv(): Env {
  return { ADMIN_TOKEN: "test-admin-token" } as Env;
}

test("dashboard enforces nonce-only scripts and blocks all inline attributes", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/dashboard"), pageEnv(), ctx);
  assert.equal(response.status, 200);
  const csp = response.headers.get("Content-Security-Policy") || "";
  const html = await response.text();
  assert.match(csp, /script-src 'nonce-/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /style-src-attr 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(html, /\sonclick\s*=|\sonerror\s*=|\sstyle\s*=/i);
  assert.match(html, /data-action="run-sync"/);
  assert.match(html, /data-action="add-rule"/);
  assert.match(html, /<script nonce="[^"]+"/);
});

test("Plaid setup uses a nonce for scripts and only retains Plaid-required inline style attributes", async () => {
  const response = await workerEntry.routeFetch(new Request("https://worker.example/setup"), pageEnv(), ctx);
  assert.equal(response.status, 200);
  const csp = response.headers.get("Content-Security-Policy") || "";
  const html = await response.text();
  assert.match(csp, /script-src 'nonce-/);
  assert.doesNotMatch(csp, /script-src-attr 'unsafe-inline'/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /https:\/\/production\.plaid\.com/);
  assert.match(csp, /frame-src https:\/\/cdn\.plaid\.com/);
  assert.doesNotMatch(html, /\sonclick\s*=|\sonerror\s*=|\sstyle\s*=/i);
  assert.match(html, /data-action="add-bank"/);
  assert.match(html, /<script nonce="[^"]+" src="https:\/\/cdn\.plaid\.com/);
});

test("sensitive debug endpoints are disabled unless explicitly opted in", async () => {
  const env = { ...pageEnv(), ENABLE_SENSITIVE_DIAGNOSTICS: "false" } as Env;
  const response = await workerEntry.routeFetch(new Request("https://worker.example/debug/plaid/raw"), env, ctx);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Detailed diagnostics are disabled/);
});

test("production readiness endpoint verifies live KV and Durable Object access without exposing data", async () => {
  const env = {
    ...pageEnv(),
    SYNC_LOCK: makeTestSyncLock(),
    SYNC_STATE: { get: async () => null }
  } as unknown as Env;
  const response = await workerEntry.routeFetch(new Request("https://worker.example/admin/security-readiness", {
    headers: { "x-admin-token": env.ADMIN_TOKEN }
  }), env, ctx);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.deepEqual(body.bindings, { SYNC_STATE: true, SYNC_LOCK: true });
  assert.equal(body.durable_object.class, "SyncLock");
  assert.equal(body.durable_object.storage, "available");
  assert.equal(JSON.stringify(body).includes(env.ADMIN_TOKEN), false);
});
