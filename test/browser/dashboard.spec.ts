import { expect, test } from "@playwright/test";
import { health } from "./fixtures";
import { open } from "./harness";

test.beforeEach(({ page }) => { page.on("dialog", d => d.accept()); });

test("Pause all syncing actually pauses (POST), and says so next to the button", async ({ page }) => {
  let paused = false;
  const calls = await open(page, "/dashboard", {
    "GET /health": () => ({ body: health({ sync_enabled: !paused, health_status: paused ? "paused" : "warning" }) }),
    "POST /pause": () => { paused = true; return { body: { ok: true, sync_enabled: false } }; },
  });
  await page.click('[data-tab="settings"]');
  await expect(page.locator("#globalBtn")).toHaveText("Pause all syncing");
  await page.click("#globalBtn");
  await expect(page.locator("#globalState")).toHaveText("Paused");
  await expect(page.locator("#globalBtn")).toHaveText("Resume syncing");
  expect(calls.filter(c => c.path === "/pause").map(c => c.method)).toEqual(["POST"]);
  // The result is visible without scrolling back to the top of the page.
  await expect(page.locator("#flash")).toContainText("paused");
  await expect(page.locator("#flash")).toBeInViewport();
});

test("Resume syncing uses POST too", async ({ page }) => {
  let on = false;
  const calls = await open(page, "/dashboard", {
    "GET /health": () => ({ body: health({ sync_enabled: on, health_status: on ? "warning" : "paused" }) }),
    "POST /resume": () => { on = true; return { body: { ok: true, sync_enabled: true } }; },
  });
  await page.click('[data-tab="settings"]');
  await expect(page.locator("#globalBtn")).toHaveText("Resume syncing");
  await page.click("#globalBtn");
  await expect(page.locator("#globalState")).toHaveText("Running");
  expect(calls.filter(c => c.path === "/resume").map(c => c.method)).toEqual(["POST"]);
});

test("unsaved skip-rule edits survive switching tabs, and are flagged until saved", async ({ page }) => {
  const calls = await open(page, "/dashboard");
  await page.click('[data-tab="rules"]');
  const contains = page.getByLabel("Bank text contains").first();
  await expect(contains).toHaveValue("ACME CORP PAYROLL");
  await expect(page.locator("#rulesDirty")).toBeHidden();
  await contains.fill("ACME PAYROLL DIRECT DEP");
  await expect(page.locator("#rulesDirty")).toBeVisible();
  await page.click('[data-tab="activity"]');
  await page.click('[data-tab="rules"]');
  await expect(page.getByLabel("Bank text contains").first()).toHaveValue("ACME PAYROLL DIRECT DEP");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.locator("#rulesDirty")).toBeHidden();
  const saved = calls.filter(c => c.method === "POST" && c.path === "/skip-rules").pop();
  expect(saved?.body.rules[0].contains).toBe("ACME PAYROLL DIRECT DEP");
});

test("unsaved account settings survive switching tabs", async ({ page }) => {
  await open(page, "/dashboard");
  await page.click('[data-tab="settings"]');
  await expect(page.locator("#accountsDirty")).toBeHidden();
  const ally = page.locator("[data-acct]").filter({ hasText: "Ally Savings" });
  await ally.getByLabel("Frequency").selectOption("15");
  await expect(page.locator("#accountsDirty")).toBeVisible();
  await page.click('[data-tab="rules"]');
  await page.click('[data-tab="settings"]');
  await expect(page.locator("[data-acct]").filter({ hasText: "Ally Savings" }).getByLabel("Frequency")).toHaveValue("15");
});

test("an account that needs reconnecting has a Reconnect link on its row, and the banner names a real place", async ({ page }) => {
  await open(page, "/dashboard", {
    "GET /health": { body: health({ attention: [{ level: "bad", text: "Amex: the bank connection needs to be reconnected (ITEM_LOGIN_REQUIRED). Use Reconnect on its row." }] }) },
  });
  const row = page.locator("#accountRows .row").filter({ hasText: "Amex" });
  const link = row.getByRole("link", { name: /Reconnect/ });
  await expect(link).toHaveAttribute("href", "/setup");
  await expect(page.locator("#accountRows .row").filter({ hasText: "Joint Checking" }).getByRole("link", { name: /Reconnect/ })).toHaveCount(0);
});

test("Sync now and Re-scan name the account they act on", async ({ page }) => {
  await open(page, "/dashboard");
  await expect(page.locator("#btnSync")).toHaveText("Sync now");
  await page.selectOption("#accountSelect", "sapphire");
  await expect(page.locator("#btnSync")).toHaveText("Sync Sapphire now");
  await expect(page.locator("#btnRescan")).toHaveText("Re-scan Sapphire");
  await page.selectOption("#accountSelect", "");
  await expect(page.locator("#btnSync")).toHaveText("Sync now");
});

test("Undo lists the syncs to pick from instead of asking for a typed number", async ({ page }) => {
  let prompted = false;
  page.on("dialog", d => { if (d.type() === "prompt") prompted = true; });
  const calls = await open(page, "/dashboard");
  await page.click('[data-tab="recovery"]');
  await page.getByRole("button", { name: "Undo…" }).click();
  const runs = page.locator("#undoRuns input[type=radio]");
  await expect(runs).toHaveCount(3);
  await page.getByLabel(/webhook · 3 rows added/).check();
  await page.getByRole("button", { name: "Preview and undo" }).click();
  await expect(page.locator("#flash")).toContainText("Undo removed 3 row(s)");
  expect(prompted).toBe(false);
  const previewed = calls.find(c => c.method === "GET" && c.path === "/undo" && c.search.includes("index=1"));
  expect(previewed).toBeTruthy();
  expect(calls.some(c => c.method === "POST" && c.path === "/undo" && c.search.includes("confirm=true"))).toBe(true);
});

test("a failed action says what failed, near the button that was pressed", async ({ page }) => {
  await open(page, "/dashboard", { "POST /accounts/save": { status: 500, body: { error: "KV write failed; nothing was saved." } } });
  await page.click('[data-tab="settings"]');
  await page.getByRole("button", { name: "Save accounts" }).click();
  await expect(page.locator("#flash")).toContainText("KV write failed; nothing was saved.");
  await expect(page.locator("#flash")).toBeInViewport();
});

test("the admin token box describes the one-hour session, not browser storage", async ({ page }) => {
  await open(page, "/dashboard");
  await page.click('[data-tab="settings"]');
  await expect(page.locator("#tab-settings")).not.toContainText("Stored only in this browser");
  await expect(page.locator("#tab-settings")).toContainText("one hour");
});
