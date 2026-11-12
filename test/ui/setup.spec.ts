import { expect, test } from "@playwright/test";
import { open } from "./harness";

const linked = {
  "POST /exchange-token": { body: { ok: true, link_id: "link-1", item_id: "item-cap", accounts: [{ account_id: "p-cap", name: "Venture", mask: "5521", type: "credit", subtype: "credit card" }] } },
  "POST /accounts/add": { body: { ok: true, added: "venture", note: "Added with sync OFF. Set its YNAB starting balance to the bank's posted balance, then turn its sync on in the dashboard (Settings)." } },
};
// Plaid Link itself can't run here; call what it calls when a bank is linked.
const finishLink = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).onLinked("public-sandbox", { institution: { name: "Capital One" } }));

test("after linking, the page says new accounts start with sync off", async ({ page }) => {
  await open(page, "/setup", linked);
  await finishLink(page);
  await expect(page.locator("#status")).toContainText("sync off");
  await expect(page.locator("body")).not.toContainText("starts syncing on the next run");
});

test("the YNAB account picker marks accounts another bank account already feeds, and asks before reusing one", async ({ page }) => {
  const calls = await open(page, "/setup", linked);
  await finishLink(page);
  const pick = page.locator('[data-f="ynab"]');
  await expect(pick.locator("option", { hasText: "Chase Sapphire" })).toContainText("already fed by Sapphire");
  await expect(pick.locator("option", { hasText: "Capital One Venture" })).not.toContainText("already fed");

  await page.fill('[data-f="nickname"]', "venture");
  await pick.selectOption({ label: "Chase Sapphire (already fed by Sapphire)" });
  page.once("dialog", d => { expect(d.message()).toContain("double"); d.dismiss(); });
  await page.getByRole("button", { name: "Add this account" }).click();
  expect(calls.some(c => c.path === "/accounts/add")).toBe(false);

  await pick.selectOption({ label: "Capital One Venture" });
  await page.getByRole("button", { name: "Add this account" }).click();
  await expect(page.locator("#status")).toContainText("Added with sync OFF");
  expect(calls.filter(c => c.path === "/accounts/add")[0].body.ynab_account_id).toBe("y-cap");
});

test("the result of adding an account is shown where you clicked", async ({ page }) => {
  await open(page, "/setup", linked);
  await finishLink(page);
  await page.fill('[data-f="nickname"]', "venture");
  await page.locator('[data-f="ynab"]').selectOption({ label: "Capital One Venture" });
  await page.getByRole("button", { name: "Add this account" }).click();
  await expect(page.locator("#status")).toBeInViewport();
});

test("the bank that needs reconnecting is marked on the Reconnect list", async ({ page }) => {
  await open(page, "/setup");
  const amex = page.locator("#banks .row").filter({ hasText: "American Express" });
  await expect(amex).toContainText("Needs reconnect");
  await expect(page.locator("#banks .row").filter({ hasText: "Chase" })).not.toContainText("Needs reconnect");
});
