import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_FRAMING, json } from "../src/util/http";

test("admin HTML responses receive browser hardening headers", () => {
  assert.equal(NO_FRAMING["X-Frame-Options"], "DENY");
  assert.equal(NO_FRAMING["X-Content-Type-Options"], "nosniff");
  assert.equal(NO_FRAMING["Referrer-Policy"], "no-referrer");
  assert.equal(NO_FRAMING["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  assert.match(NO_FRAMING["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(NO_FRAMING["Content-Security-Policy"], /object-src 'none'/);
  assert.match(NO_FRAMING["Content-Security-Policy"], /base-uri 'none'/);
});

test("JSON API responses are non-cacheable and protected from MIME sniffing", () => {
  const response = json({ ok: true });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});
