import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = 8791;
const origin = "http://127.0.0.1:" + port;
const child = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" }
});
let serverOutput = "";
child.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
child.stderr.on("data", chunk => { serverOutput += chunk.toString(); });

let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error("wrangler dev exited early:\n" + serverOutput);
    try {
      const response = await fetch(origin + "/dashboard");
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await delay(1000);
  }
  assert.equal(ready, true, "wrangler dev did not become ready:\n" + serverOutput);

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const cspViolations = [];
  const pageErrors = [];
  page.on("console", message => {
    if (/content security policy|refused to (?:execute|apply|load)/i.test(message.text())) cspViolations.push(message.text());
  });
  page.on("pageerror", error => pageErrors.push(error.message));

  const dashboard = await page.goto(origin + "/dashboard", { waitUntil: "domcontentloaded" });
  assert.equal(dashboard.status(), 200);
  const dashboardCsp = dashboard.headers()["content-security-policy"] || "";
  assert.match(dashboardCsp, /script-src 'nonce-/);
  assert.match(dashboardCsp, /script-src-attr 'none'/);
  assert.doesNotMatch(dashboardCsp, /unsafe-inline/);
  assert.equal(await page.locator("[onclick], [onerror], [style]").count(), 0);
  const addRuleFunction = await page.evaluate(() => typeof window.addRule);
  assert.equal(addRuleFunction, "function", "dashboard script did not initialize; page errors: " + JSON.stringify(pageErrors) + "; CSP violations: " + JSON.stringify(cspViolations));
  assert.equal(await page.locator('[data-action="add-rule"]').count(), 1, "add-rule control missing");
  await page.locator('[data-tab="rules"]').click();
  await page.locator('[data-action="add-rule"]').click();
  assert.equal(await page.locator("#rules .card.item").count(), 1, "dashboard delegated click handler did not add a rule; page errors: " + JSON.stringify(pageErrors) + "; CSP violations: " + JSON.stringify(cspViolations));

  await page.route("https://cdn.plaid.com/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Plaid = { create: function () { return { open: function () {} }; } };"
  }));
  const setup = await page.goto(origin + "/setup", { waitUntil: "domcontentloaded" });
  assert.equal(setup.status(), 200);
  const setupCsp = setup.headers()["content-security-policy"] || "";
  assert.match(setupCsp, /script-src 'nonce-/);
  assert.doesNotMatch(setupCsp, /script-src-attr 'unsafe-inline'/);
  assert.match(setupCsp, /style-src-attr 'unsafe-inline'/); // Required by Plaid Link's documented CSP.
  assert.match(setupCsp, /https:\/\/production\.plaid\.com/);
  assert.equal(await page.locator("[onclick], [onerror], [style]").count(), 0);
  assert.equal(await page.locator('script:not([nonce])').count(), 0);
  await page.locator("#addBtn").click();
  await page.locator("#status.err").waitFor({ state: "visible", timeout: 5000 });

  assert.deepEqual(cspViolations, [], "browser reported CSP violations");
  assert.deepEqual(pageErrors, [], "browser reported uncaught page errors");
  console.log("PASS  Dashboard and setup rendered in Chromium with no CSP violations");
  console.log("PASS  Dashboard delegated actions work");
  console.log("PASS  Plaid setup script is nonce-authorized and its action handler runs");
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
}
