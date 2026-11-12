import { expect, test } from "@playwright/test";
import { open } from "./harness";

test("on a phone, Activity shows one card per event with nothing cut off", async ({ page }, info) => {
  test.skip(info.project.name !== "phone");
  await open(page, "/dashboard");
  const first = page.locator("#events tr").nth(1);
  await expect(first).toContainText("Pending imported");
  const box = await first.boundingBox();
  const table = await page.locator("#events").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(table!.width + 1);
  // The whole detail is visible inside the card, not behind a sideways scroll.
  const detail = first.locator(".ev-detail");
  const d = await detail.boundingBox();
  expect(d!.x + d!.width).toBeLessThanOrEqual(table!.x + table!.width + 1);
  await expect(detail).toBeVisible();
  expect(await page.locator("#events").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  // Dates fit on one line.
  const when = await first.locator(".ev-when").boundingBox();
  expect(when!.height).toBeLessThan(24);
});
