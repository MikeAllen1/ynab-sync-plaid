import { test } from "node:test";
import assert from "node:assert/strict";
import { workerEntry } from "../src/index";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

for (const path of ["/dashboard", "/setup"]) {
  test(path + " sends a nonce-based CSP without inline event or style attributes", async () => {
    const response = await workerEntry.routeFetch(new Request("https://worker.example" + path), {} as any, ctx);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control") || "", /no-store/);
    const policy = response.headers.get("Content-Security-Policy") || "";
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes("script-src-attr 'none'") || !policy.includes("script-src-attr"));
    assert.ok(policy.includes("style-src-attr 'none'"));
    assert.equal(policy.includes("'unsafe-inline'"), false);

    const html = await response.text();
    const scripts = [...html.matchAll(/<script\\b([^>]*)>/gi)];
    assert.ok(scripts.length > 0);
    for (const script of scripts) assert.match(script[1], /\\bnonce="/i);
    assert.doesNotMatch(html, /<[^>]+\\son(?:click|change|input|submit)\\s*=/i);
    assert.doesNotMatch(html, /<[^>]+\\sstyle\\s*=/i);
  });
}
