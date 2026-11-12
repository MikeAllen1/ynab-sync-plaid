// End-to-end checks of dashboard workflows in a real browser: each test starts the
// harness (the real worker, in-memory storage, fake Plaid and YNAB), drives the page,
// and checks what was actually stored, not just what the page said.
//
//   npm run test:browser          (needs Chrome/Chromium; set CHROME_PATH if it isn't
//                                  at /usr/bin/google-chrome)
//
// Not part of `npm test`, which has to run without a browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "dev-admin-token";
const HARNESS = fileURLToPath(new URL("./harness.ts", import.meta.url));
let browser: Browser;
let harness: ChildProcess | null = null;

async function startHarness() {
  if (harness) { harness.kill(); await new Promise(r => harness!.once("exit", r)); }
  harness = spawn(process.execPath, ["--import", "tsx", HARNESS], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try { await fetch(BASE + "/__qa/state"); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error("harness did not start");
}
const qa = async (cmd: string, params: Record<string, string> = {}, body?: unknown) =>
  (await fetch(`${BASE}/__qa/${cmd}?${new URLSearchParams(params)}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })).json();
const kv = async (key: string) => { const v = (await qa("state")).kv[key]; return v ? JSON.parse(v) : null; };
const api = async (path: string, method = "GET", body?: unknown) =>
  (await fetch(BASE + path, { method, headers: { "x-admin-token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();

async function dashboard(mobile = false): Promise<Page> {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", d => d.type() === "prompt" ? d.accept("0") : d.accept());
  await page.goto(BASE + "/dashboard#token=" + TOKEN);
  await page.waitForSelector("#accountRows .row-name:not(:has-text('Loading'))");
  await page.waitForTimeout(300);
  return page;
}
async function openTab(page: Page, name: string) { await page.click(`.tab[data-tab='${name}']`); await page.waitForTimeout(500); }
const flash = (page: Page) => page.locator("#flash").innerText();

before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); harness?.kill(); });

test("Pause all syncing actually pauses", async () => {
  await startHarness();
  const page = await dashboard();
  await openTab(page, "settings");
  await page.click("#globalBtn");
  await page.waitForTimeout(800);
  assert.equal((await qa("state")).kv["sync:enabled"], "false");
  assert.equal(await page.innerText("#globalState"), "Paused");
  assert.equal(await page.innerText("#globalBtn"), "Resume syncing");
  await page.click("#globalBtn");
  await page.waitForTimeout(800);
  assert.equal((await qa("state")).kv["sync:enabled"], "true");
});

test("double-clicking Remove on a transfer label removes only that label", async () => {
  await startHarness();
  const page = await dashboard();
  await openTab(page, "rules");
  await qa("delay", { path: "/transfer-labels" });
  await page.locator("#tlabels [data-click='deleteTLabel']").first().dblclick();
  await page.waitForTimeout(2000);
  assert.deepEqual((await kv("transfer_labels")).map((l: any) => l.tail), ["2222", "3333"]);
});

test("deleting a rule doesn't save half-typed edits to other rules or an unfinished new rule", async () => {
  await startHarness();
  await api("/skip-rules", "POST", { rules: [
    { id: "r1", enabled: true, account: "checking", contains: "PAYROLL", transaction_type: "inflow", reason: "a" },
    { id: "r2", enabled: true, account: "checking", contains: "VENMO", transaction_type: "inflow", reason: "b" }] });
  const page = await dashboard();
  await openTab(page, "rules");
  await page.fill("[data-r='0'][data-f='contains']", "PAY");
  await page.click("[data-click='addRule']");
  await page.fill("[data-r='2'][data-f='contains']", "A");
  await page.locator("[data-click='deleteRule'][data-arg='1']").click();
  await page.waitForTimeout(800);
  assert.deepEqual((await kv("skip_rules")).map((r: any) => r.contains), ["PAYROLL"]);
  // The unsaved edits are still on screen.
  assert.equal(await page.inputValue("[data-r='0'][data-f='contains']"), "PAY");
  assert.equal(await page.locator("#rules .card").count(), 2);
});

test("saving a rule without bank text is refused, not silently dropped", async () => {
  await startHarness();
  const page = await dashboard();
  await openTab(page, "rules");
  await page.click("[data-click='addRule']");
  await page.fill("[data-r='0'][data-f='reason']", "Paycheck entered ahead");
  await page.click("[data-click='saveRules']");
  await page.waitForTimeout(600);
  assert.match(await flash(page), /Nothing was saved/);
  assert.equal(await page.locator("#rules .card").count(), 1);
});

test("Save accounts on a page loaded before a bank was added elsewhere keeps the new account", async () => {
  await startHarness();
  const page = await dashboard();
  await openTab(page, "settings");
  const ex = await api("/exchange-token", "POST", { public_token: "public-sandbox" });
  const add = await api("/accounts/add", "POST", { link_id: ex.link_id, plaid_account_id: "acct-new", ynab_account_id: "ynab-new", nickname: "savings", is_credit_card: false });
  assert.equal(add.ok, true);
  await page.selectOption("[data-acct='0'] [data-f='sync_frequency_minutes']", "30");
  await page.click("[data-click='saveAccounts']");
  await page.waitForTimeout(900);
  assert.deepEqual((await kv("account_config_bundle")).accounts.map((a: any) => a.nickname), ["checking", "amex", "savings"]);
  assert.match(await flash(page), /changed somewhere else/);
  assert.equal(await page.locator("#accounts [data-acct]").count(), 3, "the reloaded list shows the new account");
});

test("unsaved edits survive switching tabs, and leaving the page asks first", async () => {
  await startHarness();
  const page = await dashboard();
  await openTab(page, "settings");
  await page.selectOption("[data-acct='1'] [data-f='sync_frequency_minutes']", "240");
  await openTab(page, "activity");
  await openTab(page, "settings");
  assert.equal(await page.inputValue("[data-acct='1'] [data-f='sync_frequency_minutes']"), "240");
  const asks = await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  assert.equal(asks, true);
});

test("Sync now for one account reports only that account", async () => {
  await startHarness();
  const page = await dashboard();
  await page.uncheck("#dryRun");
  await page.selectOption("#accountSelect", "checking");
  await page.click("#btnSync");
  await page.locator("#flash").waitFor({ state: "visible" });
  assert.doesNotMatch(await flash(page), /Amex/);
});

test("results for a previous account choice aren't shown under a new one", async () => {
  await startHarness();
  await api("/sync", "POST");
  const page = await dashboard();
  await openTab(page, "reconcile");
  await qa("delay", { path: "/reconcile" });
  await page.selectOption("#accountSelect", "checking");
  await page.click("[data-click='runReconcile']");
  await page.waitForTimeout(150);
  await page.selectOption("#accountSelect", "amex");
  await page.waitForTimeout(1600);
  assert.equal(await page.locator("#recon h3").count(), 0);
});

test("dry run: Sync now, Re-scan and Re-check write nothing to YNAB (mobile viewport)", async () => {
  await startHarness();
  const page = await dashboard(true);
  await qa("reset-log");
  for (const id of ["#btnSync", "#btnRescan", "#btnRecheck"]) { await page.click(id); await page.waitForTimeout(1200); }
  const st = await qa("state");
  assert.deepEqual(st.ynabCalls.filter((c: string) => !c.startsWith("GET")), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scrolling on a phone");
});
