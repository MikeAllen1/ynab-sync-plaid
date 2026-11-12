// Browser-test harness: serves the real worker (routeFetch via workerEntry.fetch) over HTTP on
// localhost, with in-memory KV + Durable Object, and fake Plaid / YNAB backends.
// Control endpoints under /__qa/ let the browser tests inspect and mutate state.
import http from "node:http";
import { workerEntry } from "../../src/index";
import { makeTestSyncLock } from "../durable-object-fixture";

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const kv = new Map<string, string>();
const kvWrites: { key: string; op: string }[] = [];
const accounts = [
  { nickname: "checking", institution: "First Bank", plaid_access_token: "access-a", plaid_account_id: "acct-checking", ynab_account_id: "ynab-checking", item_id: "item-a", is_credit_card: false },
  { nickname: "amex", institution: "American Express", plaid_access_token: "access-c", plaid_account_id: "acct-amex", ynab_account_id: "ynab-amex", item_id: "item-c", is_credit_card: true }
];
kv.set("account_config_bundle", JSON.stringify({ version: 1, accounts, settings: [
  { nickname: "checking", sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 60, audit_enabled: true },
  { nickname: "amex", sync_enabled: false, backfill_enabled: false, sync_frequency_minutes: 60, audit_enabled: true }
] }));
kv.set("sync:enabled", "true");
kv.set("transfer_labels", JSON.stringify([{ tail: "1111", label: "Savings 1111" }, { tail: "2222", label: "Brokerage 2222" }, { tail: "3333", label: "Kids 3333" }]));

// ---- fake bank ----
const plaidTx: Record<string, any[]> = {
  "acct-checking": [
    { transaction_id: "p-1", account_id: "acct-checking", amount: 12.5, date: daysAgo(2), name: "Coffee Roasters", merchant_name: "Coffee Roasters", pending: false },
    { transaction_id: "p-2", account_id: "acct-checking", amount: 40.0, date: daysAgo(1), name: "Gas Station", merchant_name: "Gas Station", pending: true },
    { transaction_id: "p-3", account_id: "acct-checking", amount: -1500, date: daysAgo(3), name: "PAYROLL ACME", merchant_name: null, pending: false }
  ],
  "acct-amex": [
    { transaction_id: "a-1", account_id: "acct-amex", amount: 75.25, date: daysAgo(1), name: "Grocery Mart", merchant_name: "Grocery Mart", pending: false }
  ]
};
const fullTx = (t: any) => ({ pending_transaction_id: null, iso_currency_code: "USD", authorized_date: t.date, personal_finance_category: null, ...t });
const plaidAccounts: Record<string, any[]> = {
  "access-a": [{ account_id: "acct-checking", name: "Checking", mask: "1111", type: "depository", subtype: "checking", balances: { current: 2000, available: 1960, iso_currency_code: "USD" } }],
  "access-c": [{ account_id: "acct-amex", name: "Amex Gold", mask: "9876", type: "credit", subtype: "credit card", balances: { current: 75.25, available: null, iso_currency_code: "USD" } }],
  "access-new": [{ account_id: "acct-new", name: "New Savings", mask: "4444", type: "depository", subtype: "savings", balances: { current: 500, available: 500, iso_currency_code: "USD" } }]
};
const itemByToken: Record<string, string> = { "access-a": "item-a", "access-c": "item-c", "access-new": "item-new" };
const plaidCalls: string[] = [];

// ---- fake YNAB ----
let ynabSeq = 0;
const ynabRows: any[] = [];
const ynabCalls: string[] = [];
const ynabAccounts = [
  { id: "ynab-checking", name: "Checking", type: "checking", closed: false, deleted: false, on_budget: true },
  { id: "ynab-amex", name: "Amex", type: "creditCard", closed: false, deleted: false, on_budget: true },
  { id: "ynab-new", name: "New Savings", type: "savings", closed: false, deleted: false, on_budget: true }
];
const startBal: Record<string, number> = { "ynab-checking": 2000 * 1000 - 12500 + 1500000 - 1500000, "ynab-amex": 0, "ynab-new": 500000 };
function balances(id: string) {
  const rows = ynabRows.filter(r => r.account_id === id && !r.deleted);
  const cleared = startBal[id] + rows.filter(r => r.cleared !== "uncleared").reduce((s, r) => s + r.amount, 0);
  const uncl = rows.filter(r => r.cleared === "uncleared").reduce((s, r) => s + r.amount, 0);
  return { cleared_balance: cleared, uncleared_balance: uncl, balance: cleared + uncl };
}
let failNextYnabDelete = 0;

async function fakeFetch(input: any, init?: any): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const bodyText = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (url.hostname.endsWith("plaid.com")) {
    plaidCalls.push(url.pathname);
    const tok = body.access_token;
    const accts = plaidAccounts[tok] || [];
    const ids = accts.map(a => a.account_id);
    switch (url.pathname) {
      case "/accounts/get": case "/accounts/balance/get": return Response.json({ accounts: accts, item: { item_id: itemByToken[tok] }, request_id: "r" });
      case "/item/get": return Response.json({ item: { item_id: itemByToken[tok], institution_id: "ins_1", webhook: `${ORIGIN}/webhook`, error: null }, status: { transactions: { last_successful_update: new Date().toISOString() } }, request_id: "r" });
      case "/transactions/sync": {
        const all = ids.flatMap(id => (plaidTx[id] || []).map(fullTx));
        const first = !body.cursor;
        return Response.json({ added: first ? all : [], modified: [], removed: [], next_cursor: "c-" + all.length, has_more: false, accounts: accts, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", request_id: "r" });
      }
      case "/transactions/get": {
        const all = ids.flatMap(id => (plaidTx[id] || []).map(fullTx));
        return Response.json({ transactions: all, total_transactions: all.length, accounts: accts, item: { item_id: itemByToken[tok] }, request_id: "r" });
      }
      case "/transactions/refresh": return Response.json({ request_id: "r" });
      case "/item/webhook/update": return Response.json({ item: { item_id: itemByToken[tok] }, request_id: "r" });
      case "/link/token/create": return Response.json({ link_token: "link-sandbox-123", expiration: new Date(Date.now() + 3600e3).toISOString(), request_id: "r" });
      case "/item/public_token/exchange": return Response.json({ access_token: "access-new", item_id: "item-new", request_id: "r" });
    }
    return Response.json({ error_message: "fake plaid: unknown " + url.pathname }, { status: 400 });
  }
  if (url.hostname === "api.ynab.com") {
    ynabCalls.push(req.method + " " + url.pathname + url.search);
    const p = url.pathname.replace(/^\/v1\/(budgets|plans)\/[^/]+/, "");
    if (p === "/settings") return Response.json({ data: { settings: { currency_format: { iso_code: "USD" } } } });
    if (p === "/accounts") return Response.json({ data: { accounts: ynabAccounts.map(a => ({ ...a, ...balances(a.id) })), server_knowledge: 1 } });
    let m = p.match(/^\/accounts\/([^/]+)$/);
    if (m) { const a = ynabAccounts.find(x => x.id === m![1]); return a ? Response.json({ data: { account: { ...a, ...balances(a.id) } } }) : Response.json({ error: {} }, { status: 404 }); }
    m = p.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (m) {
      const since = url.searchParams.get("since_date") || "0000";
      const withDeleted = url.searchParams.has("last_knowledge_of_server");
      return Response.json({ data: { transactions: ynabRows.filter(r => r.account_id === m![1] && r.date >= since && (withDeleted || !r.deleted)), server_knowledge: 2 } });
    }
    if (p === "/transactions" && req.method === "POST") {
      const created: string[] = [], dup: string[] = [];
      for (const t of body.transactions || []) {
        if (t.import_id && ynabRows.some(r => r.import_id === t.import_id && r.account_id === t.account_id)) { dup.push(t.import_id); continue; }
        const id = "y-" + (++ynabSeq);
        ynabRows.push({ id, approved: false, category_id: null, transfer_transaction_id: null, deleted: false, flag_color: null, subtransactions: [], ...t, payee_name: t.payee_name || "Transfer" });
        created.push(id);
      }
      return Response.json({ data: { transaction_ids: created, duplicate_import_ids: dup, transactions: ynabRows.filter(r => created.includes(r.id)) } }, { status: 201 });
    }
    if (p === "/transactions" && req.method === "PATCH") {
      const ids: string[] = [];
      for (const u of body.transactions || []) { const r = ynabRows.find(x => x.id === u.id); if (r) { Object.assign(r, u); ids.push(r.id); } }
      return Response.json({ data: { transaction_ids: ids, transactions: ynabRows.filter(r => ids.includes(r.id)) } });
    }
    m = p.match(/^\/transactions\/([^/]+)$/);
    if (m) {
      const r = ynabRows.find(x => x.id === decodeURIComponent(m![1]));
      if (req.method === "DELETE") {
        if (failNextYnabDelete > 0) { failNextYnabDelete--; return Response.json({ error: { id: "500", detail: "fake failure" } }, { status: 500 }); }
        if (!r || r.deleted) return Response.json({ error: { id: "404" } }, { status: 404 });
        r.deleted = true; return Response.json({ data: { transaction: r } });
      }
      if (req.method === "PUT") { if (r) Object.assign(r, body.transaction || {}); return Response.json({ data: { transaction: r } }); }
      return r ? Response.json({ data: { transaction: r } }) : Response.json({ error: {} }, { status: 404 });
    }
    return Response.json({ error: { detail: "fake ynab: unknown " + req.method + " " + p } }, { status: 400 });
  }
  return new Response("blocked by harness: " + url.href, { status: 599 });
}
(globalThis as any).fetch = fakeFetch;

const SYNC_STATE = {
  get: async (k: string, type?: any) => { const v = kv.get(k); if (v === undefined) return null; return type === "json" || type?.type === "json" ? JSON.parse(v) : v; },
  put: async (k: string, v: string) => { kv.set(k, v); kvWrites.push({ key: k, op: "put" }); },
  delete: async (k: string) => { kv.delete(k); kvWrites.push({ key: k, op: "delete" }); },
  list: async (o: any = {}) => ({ keys: [...kv.keys()].filter(k => !o.prefix || k.startsWith(o.prefix)).map(name => ({ name })), list_complete: true })
};
const env: any = {
  PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", YNAB_TOKEN: "y", ADMIN_TOKEN: "dev-admin-token",
  PLAID_ENV: "sandbox", YNAB_BUDGET_ID: "budget", ACCOUNT_MAP: "[]", TIMEZONE: "UTC",
  SYNC_STATE, SYNC_LOCK: makeTestSyncLock(), WORKER_ORIGIN: ORIGIN
};

const apiLog: any[] = [];
let dropNextResponseFor: string | null = null;
let delayMs: Record<string, number> = {};

http.createServer(async (nreq, nres) => {
  const chunks: Buffer[] = [];
  for await (const c of nreq) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(nreq.url || "/", ORIGIN);
  if (url.pathname.startsWith("/__qa/")) {
    const cmd = url.pathname.slice(6);
    let out: any = { ok: true };
    if (cmd === "state") out = { kv: Object.fromEntries(kv), ynabRows, plaidCalls, ynabCalls, kvWrites, apiLog };
    else if (cmd === "reset-log") { apiLog.length = 0; plaidCalls.length = 0; ynabCalls.length = 0; kvWrites.length = 0; }
    else if (cmd === "kv-put") kv.set(url.searchParams.get("k")!, body.toString());
    else if (cmd === "drop-next") dropNextResponseFor = url.searchParams.get("path");
    else if (cmd === "delay") delayMs[url.searchParams.get("path")!] = Number(url.searchParams.get("ms"));
    else if (cmd === "fail-ynab-delete") failNextYnabDelete = Number(url.searchParams.get("n") || 1);
    else if (cmd === "ynab-edit") { const r = ynabRows.find(x => x.id === url.searchParams.get("id")); if (r) Object.assign(r, JSON.parse(body.toString())); out = r; }
    else if (cmd === "plaid-add") { const t = JSON.parse(body.toString()); (plaidTx[t.account_id] ||= []).push(t); }
    nres.writeHead(200, { "content-type": "application/json" }); nres.end(JSON.stringify(out)); return;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(nreq.headers)) if (typeof v === "string") headers.set(k, v);
  const req = new Request(ORIGIN + (nreq.url || "/"), { method: nreq.method, headers, body: ["GET", "HEAD"].includes(nreq.method || "GET") ? undefined : body });
  const waits: Promise<any>[] = [];
  const started = Date.now();
  const d = delayMs[url.pathname]; if (d) await new Promise(r => setTimeout(r, d));
  let resp: Response;
  try { resp = await workerEntry.fetch(req, env, { waitUntil: (p: Promise<any>) => waits.push(p), passThroughOnException() {} } as any); }
  catch (e: any) { resp = new Response(String(e?.stack || e), { status: 599 }); }
  const text = await resp.text();
  if (!url.pathname.startsWith("/dashboard") && url.pathname !== "/setup") apiLog.push({ t: started, method: nreq.method, path: url.pathname + url.search, status: resp.status, body: body.length ? body.toString().slice(0, 600) : undefined, resp: text.slice(0, 600) });
  if (dropNextResponseFor && url.pathname === dropNextResponseFor) { dropNextResponseFor = null; nreq.socket.destroy(); return; }
  const h: Record<string, string> = {}; resp.headers.forEach((v, k) => { h[k] = v; });
  // Chrome only accepts Secure cookies on http://localhost, which this is.
  nres.writeHead(resp.status, h); nres.end(text);
}).listen(PORT, () => console.log("harness on " + ORIGIN));
