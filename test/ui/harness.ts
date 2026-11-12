// Browser tests: serve the real dashboard and setup pages, and answer the worker's
// endpoints from fixtures, so the UI can be exercised without Plaid, YNAB or Cloudflare.
import type { Page, Route } from "@playwright/test";
import { dashboardHtml } from "../../src/ui/dashboard-page";
import { setupHtml } from "../../src/ui/setup-page";
import { newCspNonce, pageSecurityHeaders } from "../../src/util/http";
import { ACCOUNTS, EVENTS, ITEMS, SETTINGS, UNDO_LIST, YNAB_ACCOUNTS, health } from "./fixtures";

export const ORIGIN = "https://sync.test";

export type Reply = { status?: number; body: unknown } | ((req: { method: string; url: URL; body: any }) => { status?: number; body: unknown });
export interface Calls { method: string; path: string; search: string; body: any }

/** Default answers, keyed by "METHOD /path" or "/path" (any method). Tests override any of them. */
export function defaults(): Record<string, Reply> {
  return {
    "GET /session": { body: { ok: true, expires_at: new Date(Date.now() + 3600_000).toISOString() } },
    "POST /session": { body: { ok: true, expires_at: new Date(Date.now() + 3600_000).toISOString() } },
    "GET /health": { body: health() },
    "/events": { body: { ok: true, events: EVENTS } },
    "/item-health": { body: { ok: true, items: ITEMS } },
    "GET /accounts": { body: { ok: true, accounts: ACCOUNTS } },
    "GET /account-settings": { body: { settings: SETTINGS } },
    "GET /skip-rules": { body: { rules: [{ id: "r1", enabled: true, account: "joint-checking", contains: "ACME CORP PAYROLL", transaction_type: "inflow", amounts: [2650], reason: "Entered manually in YNAB" }] } },
    "POST /skip-rules": ({ body }) => ({ body: { rules: body.rules } }),
    "GET /payee-aliases": { body: { aliases: [] } },
    "GET /transfer-labels": { body: { labels: [] } },
    "/debug/stuck-pending": { body: { entries: [] } },
    "GET /undo": ({ url }) => url.searchParams.get("list") ? { body: UNDO_LIST } : {
      body: { ok: true, target: { ts: UNDO_LIST.runs[Number(url.searchParams.get("index") || 0)]?.ts }, message: "This would delete 3 of 3 transaction(s) created by the \"webhook\" sync." },
    },
    "POST /undo": { body: { ok: true, undone: true, deleted: 3, kept: [] } },
    "POST /pause": { body: { ok: true, sync_enabled: false } },
    "POST /resume": { body: { ok: true, sync_enabled: true } },
    "POST /accounts/save": { body: { ok: true } },
    "GET /debug/account-map": { body: ACCOUNTS.map(a => ({ nickname: a.nickname, institution: a.institution, plaid_account_id: a.plaid_account_id, token_preview: a.token_preview, login: a.item_id })) },
    "GET /ynab-accounts": { body: { ok: true, accounts: YNAB_ACCOUNTS } },
  };
}

/** Opens a page ("/dashboard" or "/setup") with the given endpoint answers on top of the defaults. */
export async function open(page: Page, path: "/dashboard" | "/setup", overrides: Record<string, Reply> = {}): Promise<Calls[]> {
  const replies = { ...defaults(), ...overrides };
  const calls: Calls[] = [];
  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();            // Plaid's CDN and anything else outside
    if (req.method() === "GET" && (url.pathname === "/dashboard" || url.pathname === "/setup")) {
      const nonce = newCspNonce();
      const html = url.pathname === "/dashboard" ? await dashboardHtml(nonce).text() : setupHtml(nonce);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: pageSecurityHeaders(nonce, url.pathname === "/setup" ? "setup" : "dashboard"), body: html });
    }
    let body: any = null;
    try { body = req.postData() ? JSON.parse(req.postData()!) : null; } catch { body = req.postData(); }
    calls.push({ method: req.method(), path: url.pathname, search: url.search, body });
    // Like the worker: a route that exists but not for this method answers 405.
    const r = replies[`${req.method()} ${url.pathname}`] ?? replies[url.pathname] ??
      (Object.keys(replies).some(k => k.endsWith(" " + url.pathname)) ? { status: 405, body: { error: "POST only" } } : { status: 404, body: { error: "not found" } });
    const out = typeof r === "function" ? r({ method: req.method(), url, body }) : r;
    return route.fulfill({ status: out.status ?? 200, contentType: "application/json", body: JSON.stringify(out.body) });
  });
  await page.goto(ORIGIN + path);
  return calls;
}
