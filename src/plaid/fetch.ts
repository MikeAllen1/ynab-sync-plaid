import { YNAB_LOOKBACK_DAYS } from "../constants";
import { plaidCall } from "./client";
import { getAccounts } from "../store/accounts";
import { VERIFY_WINDOW_DAYS } from "../sync/engine";
import { AccountConfig, Env, PlaidTransaction, normalizePlaidTxn } from "../types";

// ---------- Debug endpoints ----------

export async function debugPlaidRawTransactions(env: Env, url: URL): Promise<any> {
  const accounts = await getAccounts(env);
  const accountNickname = url.searchParams.get("account") || accounts[0]?.nickname || "";
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || "30")));
  const count = Math.max(1, Math.min(100, Number(url.searchParams.get("count") || "30")));

  const acct = accounts.find(a => a.nickname === accountNickname);

  if (!acct) {
    return {
      ok: false,
      error: `No mapped account named '${accountNickname}'.`,
      valid_accounts: accounts.map(a => a.nickname)
    };
  }

  const end = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - days);

  const start_date = toIsoDate(start);
  const end_date = toIsoDate(end);

  let plaid: any;

  try {
    plaid = await plaidCall(env, "/transactions/get", {
      access_token: acct.plaid_access_token,
      start_date,
      end_date,
      options: {
        account_ids: [acct.plaid_account_id],
        count,
        offset: 0,
        include_personal_finance_category: true
      }
    });
  } catch (e: any) {
    return {
      ok: false,
      account: acct.nickname,
      plaid_account_id: acct.plaid_account_id,
      plaid_access_token_preview: (acct.plaid_access_token || "").substring(0, 20) + "...",
      error: e?.message || String(e)
    };
  }

  const transactions = (plaid.transactions || []).map((t: any) => ({
    transaction_id: t.transaction_id,
    pending_transaction_id: t.pending_transaction_id || null,
    account_id: t.account_id,
    date: t.date,
    authorized_date: t.authorized_date || null,
    name: t.name,
    merchant_name: t.merchant_name || null,
    amount: t.amount,
    pending: !!t.pending,
    iso_currency_code: t.iso_currency_code || null,
    category: t.category || null,
    personal_finance_category: t.personal_finance_category || null
  }));

  return {
    ok: true,
    account: acct.nickname,
    plaid_account_id: acct.plaid_account_id,
    range: { start_date, end_date, days },
    count_requested: count,
    total_transactions: plaid.total_transactions,
    returned_count: transactions.length,
    transactions,
    note: "This reads raw Plaid /transactions/get for the mapped account and does not move the sync cursor."
  };
}

// Reads made earlier in the same run (one cron tick or one request) are reused: the
// sync, the health check and the stuck-row trace all read each account's recent bank
// history, and YNAB's account list is needed per account. Cloudflare limits how many
// outside calls one run may make (50 on the Free plan). The cache is cleared at the
// start of every run, so nothing carries over between runs.
export let runCache = new Map<string, any>();
export function resetRunCache(): void { runCache = new Map(); }
// One /item/get per bank login per run (a checking account and a card at the same bank share a login).
export async function plaidItemCached(env: Env, accessToken: string): Promise<any> {
  const key = `plaid_item:${accessToken}`;
  if (!runCache.has(key)) runCache.set(key, plaidCall(env, "/item/get", { access_token: accessToken }));
  try { return await runCache.get(key); } catch (e) { runCache.delete(key); throw e; }
}

export async function getRecentRawTransactionsDetailed(
  env: Env, acct: AccountConfig, days: number, count: number
): Promise<{ transactions: PlaidTransaction[]; truncated: boolean; start_date: string; end_date: string }> {
  // One read of the longest window anyone needs this run; shorter requests are cut
  // from it.
  const want = Math.max(1, Math.min(100, days));
  const key = `plaid_window:${acct.plaid_access_token}:${acct.plaid_account_id}`;
  const fetchDays = Math.max(want, VERIFY_WINDOW_DAYS + 7);
  let cached = runCache.get(key);
  if (!cached || cached.days < want) {
    cached = { days: fetchDays, result: await fetchRawWindow(env, acct, fetchDays, Math.max(count, 500)) };
    runCache.set(key, cached);
  }
  const start = new Date(); start.setUTCDate(start.getUTCDate() - want);
  const start_date = toIsoDate(start);
  return { ...cached.result, start_date, transactions: cached.result.transactions.filter((t: PlaidTransaction) => t.date >= start_date) };
}

export async function fetchRawWindow(
  env: Env, acct: AccountConfig, days: number, count: number
): Promise<{ transactions: PlaidTransaction[]; truncated: boolean; start_date: string; end_date: string }> {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - Math.max(1, Math.min(100, days)));

  const start_date = toIsoDate(start);
  const end_date = toIsoDate(end);
  const pageSize = Math.max(1, Math.min(500, count));
  const MAX_TRANSACTIONS = 1000;

  const readPass = async (): Promise<{ rows: any[]; total: number; stable: boolean }> => {
    const rows: any[] = [];
    const seenIds = new Set<string>();
    let offset = 0;
    let total = -1;
    let stable = true;
    while (rows.length < MAX_TRANSACTIONS && (total < 0 || offset < total)) {
      const plaid = await plaidCall(env, "/transactions/get", {
        access_token: acct.plaid_access_token,
        start_date,
        end_date,
        options: {
          account_ids: [acct.plaid_account_id],
          count: pageSize,
          offset,
          include_personal_finance_category: true
        }
      });
      if (!plaid || !Array.isArray(plaid.transactions) ||
          !Number.isSafeInteger(plaid.total_transactions) || plaid.total_transactions < 0) {
        throw new Error("Plaid /transactions/get returned an invalid page: transactions and non-negative total_transactions are required");
      }
      const page = plaid.transactions;
      if (total >= 0 && plaid.total_transactions !== total) stable = false;
      total = plaid.total_transactions;
      if (page.some((t: any) => !t || typeof t.transaction_id !== "string" ||
          typeof t.account_id !== "string" || typeof t.date !== "string" ||
          typeof t.amount !== "number" || !Number.isFinite(t.amount))) stable = false;
      if (page.length === 0 && offset < total) { stable = false; break; }
      if (page.length > pageSize || offset + page.length > total) { stable = false; break; }
      for (const transaction of page) {
        if (seenIds.has(transaction.transaction_id)) stable = false;
        seenIds.add(transaction.transaction_id);
      }
      rows.push(...page);
      offset += page.length;
      if (page.length === 0) break;
      if (offset < total && page.length !== pageSize) { stable = false; break; }
    }
    if (total < 0 || rows.length !== Math.min(total, MAX_TRANSACTIONS)) stable = false;
    return { rows, total: Math.max(0, total), stable };
  };

  // Plaid offset pagination has no snapshot token. For a multi-page result, take
  // a second complete pass and compare transaction identity and lifecycle fields.
  // If the underlying window shifted, callers see truncated=true and must not use
  // it to retire pending YNAB rows.
  const first = await readPass();
  let stable = first.stable;
  if (first.total > pageSize && first.total <= MAX_TRANSACTIONS) {
    const second = await readPass();
    const signature = (rows: any[]) => rows.map(t => [
      t.transaction_id, t.pending_transaction_id || "", t.account_id, t.date,
      t.authorized_date || "", Number(t.amount), !!t.pending, t.name || "",
      t.merchant_name || "", t.personal_finance_category?.primary || "",
      t.personal_finance_category?.detailed || ""
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    stable = stable && second.stable && first.total === second.total &&
      JSON.stringify(signature(first.rows)) === JSON.stringify(signature(second.rows));
  }
  const truncated = !stable || first.rows.length < first.total || first.total > MAX_TRANSACTIONS;
  return {
    transactions: first.rows.map(normalizePlaidTxn),
    truncated,
    start_date,
    end_date
  };
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function lookbackDate(env: Env): string {
  void env; // reserved for a future per-env configurable window
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - YNAB_LOOKBACK_DAYS);
  return toIsoDate(d);
}
