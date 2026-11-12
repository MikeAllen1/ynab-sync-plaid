import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workerEntry } from "../src/index";
import { runSyncAll } from "../src/sync/run";
import { appendUndo, rollbackSync } from "../src/sync/undo";
import type { Env } from "../src/types";
import { makeTestSyncLock } from "./durable-object-fixture";

// Regression tests from the user-workflow audit: what the person sees and expects
// after an action must match what the worker actually stored.

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const ORIGIN = "https://worker.example";
const checking = { nickname: "checking", institution: "First Bank", plaid_access_token: "access-a", plaid_account_id: "acct-checking", ynab_account_id: "ynab-checking", item_id: "item-a", is_credit_card: false };
const amex = { nickname: "amex", institution: "Amex", plaid_access_token: "access-c", plaid_account_id: "acct-amex", ynab_account_id: "ynab-amex", item_id: "item-c", is_credit_card: true };

function makeEnv(seed: Record<string, string> = {}) {
  const kv = new Map<string, string>(Object.entries(seed));
  const env = {
    ADMIN_TOKEN: "admin-test-token", PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s",
    YNAB_TOKEN: "y", YNAB_BUDGET_ID: "budget", ACCOUNT_MAP: "[]", TIMEZONE: "UTC",
    SYNC_LOCK: makeTestSyncLock(),
    SYNC_STATE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
      delete: async (k: string) => { kv.delete(k); }
    }
  } as unknown as Env;
  return { env, kv };
}
function bundle(settings: any[]) {
  return JSON.stringify({ version: 1, accounts: [checking, amex], settings });
}
const both = [
  { nickname: "checking", sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 60, audit_enabled: true },
  { nickname: "amex", sync_enabled: false, backfill_enabled: false, sync_frequency_minutes: 60, audit_enabled: true }
];
async function call(env: Env, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  const response = await workerEntry.routeFetch(new Request(ORIGIN + path, {
    method,
    headers: { "x-admin-token": "admin-test-token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
  return { status: response.status, data: await response.json() };
}
const accountRows = [checking, amex].map(({ plaid_access_token, ...rest }) => rest);

test("Save accounts from a page loaded before an account was added elsewhere is refused, not a silent delete", async () => {
  const { env, kv } = makeEnv({ account_config_bundle: bundle(both) });
  const loaded = await call(env, "/accounts");
  assert.ok(loaded.data.config_version, "GET /accounts returns the version the page edits");
  const settingsRead = await call(env, "/account-settings");
  assert.equal(settingsRead.data.config_version, loaded.data.config_version);

  // Another tab adds an account (simulated by writing the stored bundle).
  const savings = { ...checking, nickname: "savings", plaid_account_id: "acct-savings", ynab_account_id: "ynab-savings", item_id: "item-s" };
  kv.set("account_config_bundle", JSON.stringify({ version: 1, accounts: [checking, amex, savings], settings: both }));

  const stale = await call(env, "/accounts/save", "POST", { accounts: accountRows, settings: both, expected_version: loaded.data.config_version });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.stale, true);
  assert.match(stale.data.error, /Nothing was saved/);
  assert.deepEqual(JSON.parse(kv.get("account_config_bundle")!).accounts.map((a: any) => a.nickname), ["checking", "amex", "savings"]);

  // With the current version the same save goes through.
  const fresh = await call(env, "/accounts");
  const ok = await call(env, "/accounts/save", "POST", { accounts: [...accountRows, { nickname: "savings", plaid_account_id: "acct-savings", ynab_account_id: "ynab-savings", item_id: "item-s" }], settings: both, expected_version: fresh.data.config_version });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.notEqual(ok.data.config_version, fresh.data.config_version);
});

test("a stale settings page can't turn back on an account switched off on another device", async () => {
  const { env, kv } = makeEnv({ account_config_bundle: bundle(both) });
  const laptop = await call(env, "/accounts");
  const phone = await call(env, "/accounts");
  const off = both.map(s => s.nickname === "checking" ? { ...s, sync_enabled: false } : s);
  assert.equal((await call(env, "/accounts/save", "POST", { accounts: accountRows, settings: off, expected_version: phone.data.config_version })).status, 200);
  const res = await call(env, "/accounts/save", "POST", { accounts: accountRows, settings: both, expected_version: laptop.data.config_version });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(kv.get("account_config_bundle")!).settings.find((s: any) => s.nickname === "checking").sync_enabled, false);
});

test("saves without expected_version (scripts) keep working", async () => {
  const { env } = makeEnv({ account_config_bundle: bundle(both) });
  const res = await call(env, "/accounts/save", "POST", { accounts: accountRows, settings: both });
  assert.equal(res.status, 200);
});

for (const [path, field, key, sample] of [
  ["/skip-rules", "rules", "skip_rules", [{ id: "r1", enabled: true, account: "checking", contains: "PAYROLL", transaction_type: "inflow", reason: "x" }]],
  ["/payee-aliases", "aliases", "payee_aliases", [{ canonical: "Kroger", patterns: ["KROGER #12"] }]],
  ["/transfer-labels", "labels", "transfer_labels", [{ tail: "1234", label: "Savings 1234" }]]
] as const) {
  test(`${path}: a delete or save from an out-of-date page is refused`, async () => {
    const { env, kv } = makeEnv();
    const first = await call(env, path);
    assert.ok(first.data.version);
    const saved = await call(env, path, "POST", { [field]: sample, expected_version: first.data.version });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.data.version, first.data.version, "the save returns the new version");
    const before = kv.get(key);
    // A second page still holding the first version tries to save an empty list.
    const stale = await call(env, path, "POST", { [field]: [], expected_version: first.data.version });
    assert.equal(stale.status, 409);
    assert.equal(kv.get(key), before, "nothing changed");
    // The current version works.
    assert.equal((await call(env, path, "POST", { [field]: [], expected_version: saved.data.version })).status, 200);
  });
}

test("retrying Add this account after a lost response reports it added, not 'already exists'", async () => {
  const { env, kv } = makeEnv({
    account_config_bundle: bundle(both),
    "pending_link:link-1": JSON.stringify({ access_token: "access-new", item_id: "item-new" })
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname.endsWith("plaid.com")) return Response.json({ accounts: [{ account_id: "acct-new", mask: "4444", type: "depository" }], request_id: "r" });
    if (url.hostname === "api.ynab.com") return Response.json({ data: { accounts: [{ id: "ynab-new", name: "Savings", type: "savings", closed: false, deleted: false }], server_knowledge: 1 } });
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    const body = { link_id: "link-1", plaid_account_id: "acct-new", ynab_account_id: "ynab-new", nickname: "savings", is_credit_card: false };
    const first = await call(env, "/accounts/add", "POST", body);
    assert.equal(first.data.ok, true);
    const retry = await call(env, "/accounts/add", "POST", body);
    assert.equal(retry.data.ok, true, JSON.stringify(retry.data));
    assert.equal(retry.data.already_added, true);
    assert.equal(JSON.parse(kv.get("account_config_bundle")!).accounts.filter((a: any) => a.nickname === "savings").length, 1, "added once");
    // A different bank account under the same nickname is still refused.
    const clash = await call(env, "/accounts/add", "POST", { ...body, ynab_account_id: "ynab-other" });
    assert.equal(clash.data.ok, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("syncing one account reports only that account, not the others that are off", async () => {
  const { env } = makeEnv({ account_config_bundle: bundle(both.map(s => ({ ...s, sync_enabled: false }))) });
  const result = await runSyncAll(env, { trigger: "manual", onlyAccount: "checking" }, null);
  assert.deepEqual(result.results.map((r: any) => r.account), ["checking"]);
  assert.equal(result.results[0].status, "skipped - account sync off");
});

test("undo preview warns when rows it will delete were approved in YNAB since", async () => {
  const { env } = makeEnv({ account_config_bundle: bundle(both) });
  await appendUndo(env, "run-1", "manual", [{ id: "y-1", account: "checking" }, { id: "y-2", account: "checking" }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: { transactions: [
    { id: "y-1", account_id: "ynab-checking", date: "2026-11-10", amount: -1000, cleared: "uncleared", approved: true, import_id: "wpend:x", category_id: "cat" },
    { id: "y-2", account_id: "ynab-checking", date: "2026-11-10", amount: -2000, cleared: "uncleared", approved: false, import_id: "wpend:y" }
  ] } })) as typeof fetch;
  try {
    const preview = await rollbackSync(env, new URL(ORIGIN + "/undo?index=0"));
    assert.equal(preview.would_delete.length, 2);
    assert.equal(preview.would_delete_approved, 1);
    assert.match(preview.message, /1 of them you've already approved/);
  } finally { globalThis.fetch = originalFetch; }
});

// ---- dashboard page script: static checks for the client-side fixes ----
const page = readFileSync(new URL("../src/ui/dashboard-page.ts", import.meta.url), "utf8");

test("dashboard sends POST for pause/resume (a GET always failed with 'POST only')", () => {
  assert.match(page, /api\(on \? "\/pause" : "\/resume", \{ method: "POST" \}\)/);
});

test("deleting a rule, alias group or label saves the last-saved list minus that entry, never unsaved edits", () => {
  const del = page.slice(page.indexOf("async function deleteFromList"), page.indexOf("function loadRules"));
  assert.match(del, /state\.saved\[kind\]\.filter/);
  assert.doesNotMatch(del, /body\[E\.field\] = state\[kind\]/);
  assert.match(del, /await busy\(btn,/, "busy() disables the button so a double click can't delete a second entry");
  for (const kind of ["deleteRule", "deleteAlias", "deleteTLabel"]) assert.match(page, new RegExp(kind + ": function \\(el, arg\\) \\{ deleteFromList\\("));
});

test("list and account saves send the version they were loaded with", () => {
  assert.match(page, /expected_version: state\.versions\[kind\]/);
  assert.match(page, /expected_version: state\.acctVersion/);
});

test("incomplete entries are refused before saving instead of silently dropped", () => {
  const save = page.slice(page.indexOf("async function saveList"), page.indexOf("async function deleteFromList"));
  assert.match(save, /Nothing was saved/);
  assert.ok(save.indexOf("bad.length") < save.indexOf("api(E.path"), "validation runs before the request");
});

test("unsaved edits survive tab switches and leaving the page asks first", () => {
  assert.match(page, /if \(!force && listDirty\(kind\)\)/);
  assert.match(page, /if \(state\.acctDirty && !force\) return;/);
  assert.match(page, /addEventListener\("beforeunload"/);
});
