/**
 * A simulated world for reliability and performance runs: Cloudflare KV (with the free
 * plan's operation counters and the 25 MiB value limit), the SyncLock Durable Object,
 * a Plaid bank and a YNAB budget, all in memory. Every external call is counted, and each
 * dependency can be switched into a failure mode (down, 429, 500, hung, bad login).
 *
 * Used by test/failure-modes.test.ts and scripts/bench/sync-bench.ts.
 */
import { makeTestSyncLock } from "../durable-object-fixture";
import type { Env } from "../../src/types";

export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;

export type ProviderMode = "ok" | "429" | "500" | "hang" | "login_required" | "invalid_token" | "network";

export interface Counters {
  kvGet: number; kvPut: number; kvDelete: number; kvList: number;
  doCalls: number; plaid: number; ynab: number; ynabWrites: number;
  /** Outbound fetches (Plaid + YNAB + anything else): the free plan allows 50 per invocation. */
  external: number;
  hungRequests: number; abortedRequests: number;
  /** Time spent inside the simulators themselves (subtract from wall time to get the Worker's own CPU). */
  fakeMs: number;
}

export interface WorldOptions {
  accounts?: number;            // linked accounts (spread over banks, 3 per bank login)
  history?: number;             // Plaid transactions already in the feed per account
  ynabRowsPerAccount?: number;  // rows already in YNAB per account (outside the window too)
  today?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (base: string, delta: number) => { const t = new Date(base + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + delta); return t.toISOString().slice(0, 10); };

export function makeWorld(o: WorldOptions = {}) {
  const today = o.today || new Date().toISOString().slice(0, 10);
  const counters: Counters = { kvGet: 0, kvPut: 0, kvDelete: 0, kvList: 0, doCalls: 0, plaid: 0, ynab: 0, ynabWrites: 0, external: 0, hungRequests: 0, abortedRequests: 0, fakeMs: 0 };
  const modes = { kv: "ok" as "ok" | "down", do: "ok" as "ok" | "down", plaid: "ok" as ProviderMode, ynab: "ok" as ProviderMode,
    /** Fail only this Plaid path (e.g. "/transactions/sync"). */ plaidPath: "" };

  const byPath = new Map<string, number>();
  /** Simulated platform limits (0 = off). Free plan: 50 outbound subrequests per invocation. */
  const limits = { subrequests: 0 };

  // ---------- KV ----------
  const kvData = new Map<string, string>();
  const maxValue = { bytes: 0, key: "" };
  const kvFail = () => { if (modes.kv === "down") throw new Error("KV GET failed: 503 Service Unavailable"); };
  const kv = {
    async get(key: string, type?: any) {
      counters.kvGet++; kvFail();
      const v = kvData.get(key) ?? null;
      if (v !== null && (type === "json" || type?.type === "json")) return JSON.parse(v);
      return v;
    },
    async put(key: string, value: string) {
      counters.kvPut++; kvFail();
      const s = String(value);
      if (s.length > KV_MAX_VALUE_BYTES) throw new Error(`KV PUT failed: 413 value too large (${s.length} bytes)`);
      if (s.length > maxValue.bytes) { maxValue.bytes = s.length; maxValue.key = key; }
      kvData.set(key, s);
    },
    async delete(key: string) { counters.kvDelete++; kvFail(); kvData.delete(key); },
    async list(opts: any = {}) {
      counters.kvList++; kvFail();
      const keys = [...kvData.keys()].filter(k => k.startsWith(opts.prefix || "")).sort().map(name => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
    async getWithMetadata(key: string) { counters.kvGet++; kvFail(); return { value: kvData.get(key) ?? null, metadata: null }; },
  };

  // ---------- Durable Object (counted, switchable) ----------
  const realDo = makeTestSyncLock();
  let doQueue: Promise<void> = Promise.resolve();
  const doNs = {
    idFromName: (n: string) => n,
    get: (id: any) => {
      const s = (realDo as any).get(id);
      return {
        fetch: async (input: any, init?: any) => {
          counters.doCalls++;
          if (modes.do === "down") throw new Error("Durable Object reset because its code was updated.");
          // A real Durable Object handles one request's storage work at a time (input
          // gates); the in-memory fixture doesn't, so requests are queued here.
          const run = doQueue.then(() => s.fetch(input, init));
          doQueue = run.then(() => undefined, () => undefined);
          return run;
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  // ---------- Plaid bank ----------
  const nAccounts = o.accounts ?? 3;
  const accounts = Array.from({ length: nAccounts }, (_, i) => ({
    nickname: `acct-${i + 1}`, plaid_access_token: `access-${Math.floor(i / 3)}`, plaid_account_id: `plaid-${i + 1}`,
    ynab_account_id: `ynab-${i + 1}`, institution: `Bank ${Math.floor(i / 3) + 1}`, item_id: `item-${Math.floor(i / 3)}`,
    ...(i % 3 === 2 ? { is_credit_card: true } : {}),
  }));
  const plaidTxns: any[] = [];
  let txSeq = 0;
  const addPlaid = (acct: any, date: string, amount: number, name: string, pending = false) => {
    const t = { transaction_id: `ptx-${++txSeq}`, pending_transaction_id: null, account_id: acct.plaid_account_id, amount, iso_currency_code: "USD",
      date, authorized_date: date, name, merchant_name: name, pending, personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" } };
    plaidTxns.push(t); return t;
  };
  const history = o.history ?? 50;
  for (const a of accounts) for (let i = 0; i < history; i++) addPlaid(a, day(today, -Math.floor(i * 120 / Math.max(1, history))), 5 + (i % 97), `Store ${i % 40}`);

  // Cursor = index into the plaid change log.
  const changeLog: Array<{ kind: "added" | "modified" | "removed"; t: any }> = plaidTxns.map(t => ({ kind: "added" as const, t }));
  const syncPage = (token: string, cursor: string | undefined, count: number) => {
    const accts = new Set(accounts.filter(a => a.plaid_access_token === token).map(a => a.plaid_account_id));
    const start = cursor ? Number(cursor.split(":")[1]) : 0;
    const added: any[] = [], modified: any[] = [], removed: any[] = [];
    let i = start, n = 0;
    for (; i < changeLog.length && n < count; i++) {
      const c = changeLog[i];
      if (!accts.has(c.t.account_id)) continue;
      n++;
      if (c.kind === "removed") removed.push({ transaction_id: c.t.transaction_id, account_id: c.t.account_id });
      else (c.kind === "added" ? added : modified).push(c.t);
    }
    const more = changeLog.slice(i).some(c => accts.has(c.t.account_id));
    return { added, modified, removed, next_cursor: `${token}:${i}`, has_more: more, request_id: "r" };
  };

  // ---------- YNAB budget ----------
  const ynabRows: any[] = [];
  let ynabSeq = 0;
  const ynabAccounts = accounts.map(a => ({ id: a.ynab_account_id, name: a.nickname, type: a.is_credit_card ? "creditCard" : "checking", on_budget: true, closed: false, deleted: false,
    transfer_payee_id: `tp-${a.ynab_account_id}`, balance: 0, cleared_balance: 0, uncleared_balance: 0, note: null }));
  for (const a of accounts) for (let i = 0; i < (o.ynabRowsPerAccount ?? 0); i++)
    ynabRows.push({ id: `old-${++ynabSeq}`, account_id: a.ynab_account_id, date: day(today, -40 - (i % 2000)), amount: -1000 - i, payee_name: "Old", cleared: "reconciled", approved: true, memo: null, import_id: null, deleted: false, subtransactions: [] });

  let hangResolvers: Array<() => void> = [];
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    counters.hungRequests++;
    const signal = (init as any)?.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => { counters.abortedRequests++; reject(signal.reason ?? new DOMException("aborted", "AbortError")); });
    hangResolvers.push(() => reject(new Error("test released hung request")));
  });
  const fail = (mode: ProviderMode, init?: RequestInit, provider: "plaid" | "ynab" = "plaid"): Promise<Response> | Response | null => {
    if (mode === "ok") return null;
    if (mode === "hang") return hang(init);
    if (mode === "network") throw new TypeError("Network connection lost.");
    if (mode === "429") return Response.json(provider === "plaid" ? { error_type: "RATE_LIMIT_EXCEEDED", error_code: "TRANSACTIONS_SYNC_LIMIT", error_message: "rate limit" } : { error: { id: "429", name: "too_many_requests" } }, { status: 429, headers: { "Retry-After": "1" } });
    if (mode === "500") return Response.json(provider === "plaid" ? { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR", error_message: "internal" } : { error: { id: "500" } }, { status: 500 });
    if (mode === "login_required") return Response.json({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed" }, { status: 400 });
    if (mode === "invalid_token") return Response.json({ error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN", error_message: "provided access token is in an invalid format" }, { status: 400 });
    return null;
  };

  const fetchImpl = async (input: any, init?: RequestInit): Promise<Response> => {
    const t0 = performance.now();
    try { return await fetchInner(input, init); } finally { counters.fakeMs += performance.now() - t0; }
  };
  const fetchInner = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    counters.external++;
    const pathKey = `${(init?.method || "GET").toUpperCase()} ${url.hostname.split(".")[url.hostname.split(".").length - 2]} ${url.pathname.replace(/\/(ynab|plaid|budget)-[\w-]+/g, "/:id").replace(/[0-9a-f-]{36}/g, ":id")}`;
    byPath.set(pathKey, (byPath.get(pathKey) || 0) + 1);
    if (limits.subrequests && counters.external > limits.subrequests) throw new Error("Too many subrequests.");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname.endsWith("plaid.com")) {
      counters.plaid++;
      if (!modes.plaidPath || modes.plaidPath === url.pathname) { const f = fail(modes.plaid, init, "plaid"); if (f) return f; }
      const p = url.pathname;
      if (p === "/transactions/sync") return Response.json(syncPage(body.access_token, body.cursor, Math.min(500, body.count || 100)));
      if (p === "/transactions/get") {
        const ids = new Set(body.options?.account_ids || accounts.filter(a => a.plaid_access_token === body.access_token).map(a => a.plaid_account_id));
        const all = plaidTxns.filter(t => ids.has(t.account_id) && t.date >= body.start_date && t.date <= body.end_date);
        const off = body.options?.offset || 0, cnt = body.options?.count || 100;
        return Response.json({ transactions: all.slice(off, off + cnt), total_transactions: all.length, accounts: [], request_id: "r" });
      }
      if (p === "/accounts/get" || p === "/accounts/balance/get")
        return Response.json({ accounts: accounts.filter(a => a.plaid_access_token === body.access_token).map((a, i) => ({ account_id: a.plaid_account_id, mask: String(1000 + i), name: a.nickname, balances: { current: 0, available: 0, iso_currency_code: "USD" }, type: "depository", subtype: "checking" })), item: { item_id: "x" }, request_id: "r" });
      if (p === "/item/get") return Response.json({ item: { item_id: body.access_token, webhook: "", error: null, consent_expiration_time: null }, status: { transactions: { last_successful_update: new Date().toISOString() } }, request_id: "r" });
      if (p === "/transactions/refresh") return Response.json({ request_id: "r" });
      return Response.json({ request_id: "r" });
    }
    if (url.hostname === "api.ynab.com") {
      counters.ynab++;
      const f = fail(modes.ynab, init, "ynab"); if (f) return f;
      const p = url.pathname, m = (init?.method || "GET").toUpperCase();
      if (p.endsWith("/settings")) return Response.json({ data: { settings: { currency_format: { iso_code: "USD", decimal_digits: 2 } } } });
      if (/\/accounts$/.test(p)) return Response.json({ data: { accounts: ynabAccounts, server_knowledge: 1 } });
      let mm = /\/accounts\/([^/]+)\/transactions$/.exec(p);
      if (mm) {
        const since = url.searchParams.get("since_date") || "0000";
        return Response.json({ data: { transactions: ynabRows.filter(r => r.account_id === mm![1] && r.date >= since), server_knowledge: 1 } });
      }
      mm = /\/accounts\/([^/]+)$/.exec(p);
      if (mm) return Response.json({ data: { account: ynabAccounts.find(a => a.id === mm![1]) } });
      mm = /\/transactions\/([^/]+)$/.exec(p);
      if (mm && m === "GET") { const r = ynabRows.find(x => x.id === mm![1]); return r ? Response.json({ data: { transaction: r } }) : Response.json({ error: { id: "404" } }, { status: 404 }); }
      if (mm && m === "DELETE") { counters.ynabWrites++; const r = ynabRows.find(x => x.id === mm![1]); if (r) r.deleted = true; return Response.json({ data: { transaction: r } }); }
      if (/\/transactions$/.test(p) && m === "POST") {
        counters.ynabWrites++;
        const ids: string[] = [], dup: string[] = [];
        for (const t of body.transactions || []) {
          if (t.import_id && ynabRows.some(r => r.import_id === t.import_id && r.account_id === t.account_id)) { dup.push(t.import_id); continue; }
          const id = `ynab-row-${++ynabSeq}`;
          ynabRows.push({ id, deleted: false, approved: false, subtransactions: [], transfer_transaction_id: null, transfer_account_id: null, ...t });
          ids.push(id);
        }
        return Response.json({ data: { transaction_ids: ids, duplicate_import_ids: dup, transactions: [], server_knowledge: 1 } });
      }
      if (/\/transactions$/.test(p) && m === "PATCH") {
        counters.ynabWrites++;
        const ids: string[] = [];
        for (const u of body.transactions || []) { const r = ynabRows.find(x => x.id === u.id); if (r) { Object.assign(r, u); ids.push(r.id); } }
        return Response.json({ data: { transaction_ids: ids, transactions: [], server_knowledge: 1 } });
      }
      return Response.json({ error: { id: "404", detail: p } }, { status: 404 });
    }
    return new Response("ok");
  };

  // Every account syncing every 15 minutes (the busiest normal setup).
  kvData.set("account_automation_settings", JSON.stringify(accounts.map(a => ({ nickname: a.nickname, sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: 15, audit_enabled: true }))));
  const env = {
    ACCOUNT_MAP: JSON.stringify(accounts),
    PLAID_ENV: "production", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s",
    YNAB_TOKEN: "y", YNAB_BUDGET_ID: "budget-1", TIMEZONE: "UTC", ADMIN_TOKEN: "admin",
    SYNC_LOCK: doNs, SYNC_STATE: kv as unknown as KVNamespace,
  } as unknown as Env;

  return {
    env, counters, modes, limits, byPath, accounts, plaidTxns, ynabRows, kvData, maxValue, today,
    addPlaid, changeLog,
    /** New bank activity: `n` posted charges per account dated today. */
    newActivity(n: number, pending = false) { for (const a of accounts) for (let i = 0; i < n; i++) changeLog.push({ kind: "added", t: addPlaid(a, today, 3 + i, `New ${i}`, pending) }); },
    resetCounters() { for (const k of Object.keys(counters)) (counters as any)[k] = 0; byPath.clear(); },
    install() { const real = globalThis.fetch; globalThis.fetch = fetchImpl as typeof fetch; return () => { globalThis.fetch = real; hangResolvers.forEach(r => r()); hangResolvers = []; }; },
    releaseHung() { hangResolvers.forEach(r => r()); hangResolvers = []; },
    activeYnabRows: () => ynabRows.filter(r => !r.deleted),
  };
}

/** Runs the Worker's cron handler and waits for everything it handed to waitUntil. */
export async function runCron(worker: { scheduled: Function }, env: Env, timeoutMs = 0): Promise<{ settled: boolean; ms: number }> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const t = performance.now();
  await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as any, env, ctx);
  const all = Promise.allSettled(pending).then(() => true);
  const settled = timeoutMs ? await Promise.race([all, new Promise<boolean>(r => setTimeout(() => r(false), timeoutMs))]) : await all;
  return { settled, ms: performance.now() - t };
}
void pad;
