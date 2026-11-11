import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlaidVerificationKey, verifyPlaidWebhook, whKeyReadWindow, WH_KEY_READS_PER_WINDOW } from "../src/plaid/webhooks";
import type { Env } from "../src/types";

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

test("malformed and oversized Plaid key IDs are rejected before KV access", async () => {
  let reads = 0;
  const env = {
    SYNC_STATE: { get: async () => { reads++; return null; } }
  } as unknown as Env;
  const payload = b64url({ iat: Math.floor(Date.now() / 1000) });
  const signature = "AA";
  for (const kid of ["", "bad/kid", "x".repeat(129)]) {
    const header = b64url({ alg: "ES256", kid });
    assert.equal(await verifyPlaidWebhook(env, "{}", `${header}.${payload}.${signature}`), false);
  }
  assert.equal(reads, 0);
});

test("webhook key cache reads stop at the per-isolate budget", async () => {
  let reads = 0;
  const env = {
    SYNC_STATE: { get: async () => { reads++; return null; } }
  } as unknown as Env;
  whKeyReadWindow.start = Date.now();
  whKeyReadWindow.count = WH_KEY_READS_PER_WINDOW;
  try {
    assert.equal(await getPlaidVerificationKey(env, "valid-shaped-kid"), null);
    assert.equal(reads, 0);
  } finally {
    whKeyReadWindow.start = 0;
    whKeyReadWindow.count = 0;
  }
});
