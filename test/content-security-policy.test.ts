import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function containsExactProductionPlaidOrigin(connectSrc: string): boolean {
  return connectSrc.split(/\\s+/).some(source => {
    try {
      const origin = new URL(source);
      return origin.protocol === "https:" && origin.hostname === "production.plaid.com" &&
        origin.port === "" && origin.username === "" && origin.password === "" &&
        origin.pathname === "/" && origin.search === "" && origin.hash === "";
    } catch {
      return false;
    }
  });
}

test("Plaid CSP allowlist accepts only the exact production origin", () => {
  assert.equal(containsExactProductionPlaidOrigin("'self' https://production.plaid.com"), true);
  assert.equal(containsExactProductionPlaidOrigin("https://evil.example/https://production.plaid.com"), false);
  assert.equal(containsExactProductionPlaidOrigin("https://production.plaid.com.evil.example"), false);
  assert.equal(containsExactProductionPlaidOrigin("https://evil.example https://production.plaid.com.evil.example"), false);
  assert.equal(containsExactProductionPlaidOrigin("https://user@production.plaid.com"), false);
});

for (const path of ["/dashboard", "/setup"]) {
  test(path + " sends a nonce-based CSP without inline event or style attributes", async () => {
    const response = await workerEntry.routeFetch(new Request("https://worker.example" + path), {} as any, ctx);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control") || "", /no-store/);
    const policy = response.headers.get("Content-Security-Policy") || "";
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes("script-src-attr 'none'") || !policy.includes("script-src-attr"));
    if (path === "/setup") {
      assert.ok(policy.includes("style-src-attr 'unsafe-inline'"));
      assert.ok(policy.includes("script-src-attr 'none'"));
      const connectSrc = policy.split(";").map(part => part.trim()).find(part => part.startsWith("connect-src ")) || "";
      assert.equal(containsExactProductionPlaidOrigin(connectSrc), true);
    } else {
      assert.ok(policy.includes("style-src-attr 'none'"));
      assert.equal(policy.includes("'unsafe-inline'"), false);
    }

    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    assert.ok(scripts.length > 0);
    for (const script of scripts) assert.match(script[1], /\bnonce="/i);
    assert.doesNotMatch(html, /<[^>]+\son(?:click|change|input|submit)\s*=/i);
    assert.doesNotMatch(html, /<[^>]+\sstyle\s*=/i);
  });
}
