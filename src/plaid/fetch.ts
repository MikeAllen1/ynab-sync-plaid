import { YNAB_LOOKBACK_DAYS } from "../constants";
import { plaidCall } from "./client";
import { getAccounts } from "../store/accounts";
import { VERIFY_WINDOW_DAYS } from "../sync/engine";
import { AccountConfig, Env, PlaidTransaction, QuarantinedPlaidTxn, partitionPlaidTxns } from "../types";
import { todayInTimeZone } from "../util/dates";
import { hostTimeouts, outbound } from "../util/http";

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

  const end_date = todayInTimeZone(env);
  const start_date = shiftCalendarDate(end_date, -days);

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
export function resetRunCache(): void { runCache = new Map(); outbound.count = 0; hostTimeouts.clear(); }
// One /item/get per bank login per run (a checking account and a card at the same bank share a login).
export async function plaidItemCached(env: Env, accessToken: string): Promise<any> {
  const key = `plaid_item:${accessToken}`;
  if (!runCache.has(key)) runCache.set(key, plaidCall(env, "/item/get", { access_token: accessToken }));
  try { return await runCache.get(key); } catch (e) { runCache.delete(key); throw e; }
}

export async function getRecentRawTransactionsDetailed(
  env: Env, acct: AccountConfig, days: number, count: number
): Promise<{ transactions: PlaidTransaction[]; quarantined: QuarantinedPlaidTxn[]; truncated: boolean; start_date: string; end_date: string }> {
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
  const end_date = todayInTimeZone(env);
  const start_date = shiftCalendarDate(end_date, -want);
  return { ...cached.result, start_date, transactions: cached.result.transactions.filter((t: PlaidTransaction) => t.date >= start_date), quarantined: (cached.result.quarantined || []).filter((q: QuarantinedPlaidTxn) => !q.date || q.date >= start_date) };
}

export async function fetchRawWindow(
  env: Env, acct: AccountConfig, days: number, count: number
): Promise<{ transactions: PlaidTransaction[]; quarantined: QuarantinedPlaidTxn[]; truncated: boolean; start_date: string; end_date: string }> {
  const end_date = todayInTimeZone(env);
  const start_date = shiftCalendarDate(end_date, -Math.max(1, Math.min(100, days)));
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
      if (page.some((t: any) => t?.account_id !== acct.plaid_account_id)) {
        throw new Error("Plaid /transactions/get returned a transaction for an unexpected account.");
      }
      if (total >= 0 && plaid.total_transactions !== total) throw new Error("Plaid /transactions/get total_transactions changed during pagination.");
      total = plaid.total_transactions;
      if (page.some((t: any) => !t || typeof t.transaction_id !== "string" || !t.transaction_id ||
          typeof t.account_id !== "string" || !t.account_id ||
          typeof t.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) ||
          typeof t.amount !== "number" || !Number.isFinite(t.amount) || typeof t.pending !== "boolean")) {
        throw new Error("Plaid /transactions/get returned a malformed transaction");
      }
      if (page.some((t: any) => t.account_id !== acct.plaid_account_id)) {
        throw new Error("Plaid /transactions/get returned a transaction for an unexpected account.");
      }
      if (page.length === 0 && offset < total) throw new Error("Plaid /transactions/get returned an empty page before total_transactions was reached.");
      if (page.length > pageSize || offset + page.length > total) throw new Error("Plaid /transactions/get returned an invalid page size or offset.");
      for (const transaction of page) {
        if (seenIds.has(transaction.transaction_id)) throw new Error("Plaid /transactions/get repeated a transaction across pages.");
        seenIds.add(transaction.transaction_id);
      }
      rows.push(...page);
      offset += page.length;
      if (page.length === 0) break;
      if (offset < total && page.length !== pageSize) throw new Error("Plaid /transactions/get returned a short page before total_transactions was reached.");
    }
    if (total < 0 || (total <= MAX_TRANSACTIONS && rows.length !== total)) stable = false;
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
  const { transactions, quarantined } = partitionPlaidTxns(first.rows);
  return {
    transactions,
    quarantined,
    truncated,
    start_date,
    end_date
  };
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function lookbackDate(env: Env): string {
  return shiftCalendarDate(todayInTimeZone(env), -YNAB_LOOKBACK_DAYS);
}


// Shift an ISO calendar date without applying the host runtime's timezone.
export function shiftCalendarDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || !Number.isInteger(days)) throw new Error("Invalid calendar date shift.");
  return new Date(timestamp + days * 86400000).toISOString().slice(0, 10);
}
