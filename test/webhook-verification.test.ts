import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPlaidWebhook } from "../src/plaid/webhooks";
import type { Env } from "../src/types";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedWebhook(rawBody: string, options: { alg?: string; iat?: number } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  const header = encodeJson({ alg: options.alg ?? "ES256", kid: "qa-webhook-key" });
  const payload = encodeJson({
    iat: options.iat ?? Math.floor(Date.now() / 1000),
    request_body_sha256: hash
  });
  const input = new TextEncoder().encode(header + "." + payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, input
  );
  return {
    token: header + "." + payload + "." + base64url(new Uint8Array(signature)),
    publicJwk
  };
}

function envWithKey(jwk: JsonWebKey): Env {
  const values = new Map<string, string>([
    ["plaid_wh_key:qa-webhook-key", JSON.stringify(jwk)]
  ]);
  return {
    SYNC_STATE: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); }
    }
  } as unknown as Env;
}

test("Plaid webhook verification accepts a valid ES256 signature and exact body hash", async () => {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
  const signed = await signedWebhook(body);
  assert.equal(await verifyPlaidWebhook(envWithKey(signed.publicJwk), body, signed.token), true);
});

test("Plaid webhook verification rejects a body changed after signing", async () => {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" });
  const signed = await signedWebhook(body);
  assert.equal(await verifyPlaidWebhook(envWithKey(signed.publicJwk), body + " ", signed.token), false);
});

test("Plaid webhook verification rejects a modified signature", async () => {
  const body = JSON.stringify({ webhook_type: "ITEM", webhook_code: "ERROR" });
  const signed = await signedWebhook(body);
  const parts = signed.token.split(".");
  const signature = parts[2];
  const replacement = signature[0] === "A" ? "B" : "A";
  parts[2] = replacement + signature.slice(1);
  assert.equal(await verifyPlaidWebhook(envWithKey(signed.publicJwk), body, parts.join(".")), false);
});

test("Plaid webhook verification rejects non-ES256 algorithms before key use", async () => {
  const body = "{}";
  const signed = await signedWebhook(body, { alg: "none" });
  assert.equal(await verifyPlaidWebhook(envWithKey(signed.publicJwk), body, signed.token), false);
});

test("Plaid webhook verification rejects stale and future-issued tokens", async () => {
  const body = "{}";
  const stale = await signedWebhook(body, { iat: Math.floor(Date.now() / 1000) - 301 });
  const future = await signedWebhook(body, { iat: Math.floor(Date.now() / 1000) + 301 });
  const env = envWithKey(stale.publicJwk);
  assert.equal(await verifyPlaidWebhook(env, body, stale.token), false);
  assert.equal(await verifyPlaidWebhook(env, body, future.token), false);
});

test("Plaid webhook verification rejects an expired cached verification key", async () => {
  const body = "{}";
  const signed = await signedWebhook(body);
  const expired = { ...signed.publicJwk, expired_at: "2026-01-01T00:00:00Z" };
  assert.equal(await verifyPlaidWebhook(envWithKey(expired), body, signed.token), false);
});

test("Plaid webhook verification rejects missing, malformed, and incomplete tokens", async () => {
  const body = "{}";
  const signed = await signedWebhook(body);
  const env = envWithKey(signed.publicJwk);
  assert.equal(await verifyPlaidWebhook(env, body, null), false);
  assert.equal(await verifyPlaidWebhook(env, body, "not-a-jwt"), false);
  const parts = signed.token.split(".");
  const payload = encodeJson({ request_body_sha256: "00" });
  assert.equal(await verifyPlaidWebhook(env, body, parts[0] + "." + payload + "." + parts[2]), false);
});
