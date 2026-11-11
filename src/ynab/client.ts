import { runCache } from "../plaid/fetch";
import { Env, YNABAccountSummary, YNABExistingTransaction, YNABTransaction } from "../types";
import { fetchWithRetry, readJsonBody } from "../util/http";

export async function ynabUpsert(env: Env, transactions: YNABTransaction[]): Promise<any> {
  // When a row is a transfer (payee_id set), YNAB rejects a competing payee_name.
  // Strip payee_name on those rows so the transfer payee is used cleanly.
  const cleaned = transactions.map(t => {
    if (t.payee_id) {
      const { payee_name, ...rest } = t as any;
      return rest;
    }
    return t;
  });
  const resp = await fetchWithRetry(
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.YNAB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ transactions: cleaned })
    }
  );

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`YNAB upsert failed: ${resp.status} - ${JSON.stringify(data)}`);
  }
  if (!data?.data || !Array.isArray(data.data.transaction_ids) ||
      !Array.isArray(data.data.duplicate_import_ids)) {
    throw new Error("YNAB upsert returned an invalid success response; transaction_ids and duplicate_import_ids are required");
  }

  return {
    added: data.data.transaction_ids.length,
    duplicates: data.data.duplicate_import_ids.length,
    created_ids: data.data.transaction_ids,
    duplicate_import_ids: data.data.duplicate_import_ids
  };
}

// Bulk in-place update (PATCH). Each entry MUST carry the YNAB transaction `id`.
// Only the fields included are changed; anything omitted (payee_name, category,
// approved, memo) is left as-is, so a user's rename/category survives a pending->
// posted flip. Used by the single-feed credit-card sync to settle a row in place.
export async function ynabUpdateTransactions(env: Env, updates: any[]): Promise<{ updated: number }> {
  if (updates.length === 0) return { updated: 0 };
  const resp = await fetchWithRetry(
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${env.YNAB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ transactions: updates })
    }
  );

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`YNAB update failed: ${resp.status} - ${JSON.stringify(data)}`);
  }

  const updatedIds = data.data?.transaction_ids;
  return { updated: Array.isArray(updatedIds) ? updatedIds.length : 0 };
}


// Updates in one request; if YNAB refuses the batch, retry row by row so one bad row
// (a split parent whose amount can't change, say) doesn't block every other update
// and retirement for the account. Rows that still fail are returned, not thrown.
export async function ynabUpdateEach(env: Env, updates: any[]): Promise<{ updated: number; failed: { id: string; error: string }[] }> {
  if (updates.length === 0) return { updated: 0, failed: [] };
  try {
    return { ...(await ynabUpdateTransactions(env, updates)), failed: [] };
  } catch (batchError: any) {
    if (updates.length === 1) return { updated: 0, failed: [{ id: updates[0].id, error: String(batchError?.message || batchError) }] };
  }
  let updated = 0;
  const failed: { id: string; error: string }[] = [];
  for (const u of updates) {
    try { updated += (await ynabUpdateTransactions(env, [u])).updated; }
    catch (e: any) { failed.push({ id: u.id, error: String(e?.message || e) }); }
  }
  return { updated, failed };
}

export async function ynabGetAccounts(env: Env): Promise<YNABAccountSummary[]> {
  const hit = runCache.get("ynab_accounts");
  if (hit) return hit;
  const list = await ynabGetAccountsUncached(env);
  runCache.set("ynab_accounts", list);
  return list;
}

export async function ynabGetAccountsUncached(env: Env): Promise<YNABAccountSummary[]> {
  const resp = await fetchWithRetry(
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/accounts`,
    {
      method: "GET",
      headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
    }
  );

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`YNAB accounts failed: ${resp.status} - ${JSON.stringify(data)}`);
  }

  if (!data?.data || !Array.isArray(data.data.accounts)) {
    throw new Error("YNAB accounts returned an invalid success response: data.accounts is required");
  }
  return data.data.accounts;
}

export async function ynabGetTransaction(env: Env, id: string): Promise<YNABExistingTransaction | null> {
  const resp = await fetchWithRetry(`https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions/${encodeURIComponent(id)}`, {
    method: "GET", headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
  });
  if (resp.status === 404) return null;
  const data: any = await readJsonBody(resp);
  if (!resp.ok) throw new Error(`YNAB transaction read failed: ${resp.status} - ${JSON.stringify(data)}`);
  return data.data?.transaction || null;
}

export async function ynabGetAccountTransactions(env: Env, ynabAccountId: string, sinceDate?: string): Promise<YNABExistingTransaction[]> {
  // since_date dramatically cuts payload and rate-limit cost: instead of pulling
  // an account's entire history on every call, we only read recent transactions
  // (pending charges clear within days). Balances for reconciliation come from
  // ynabGetAccount, so nothing that needs full history relies on this list.
  const query = sinceDate ? `?since_date=${encodeURIComponent(sinceDate)}` : "";
  const resp = await fetchWithRetry(
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/accounts/${ynabAccountId}/transactions${query}`,
    {
      method: "GET",
      headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
    }
  );

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`YNAB account transactions failed: ${resp.status} - ${JSON.stringify(data)}`);
  }

  if (!data?.data || !Array.isArray(data.data.transactions)) {
    throw new Error("YNAB account transactions returned an invalid success response: data.transactions is required");
  }
  return data.data.transactions;
}

export interface YNABAccountBalances {
  cleared_balance: number;
  uncleared_balance: number;
  balance: number;
}

// Fetches the account's authoritative balances (in milliunits) so the audit can
// compare against Plaid without summing every transaction ever recorded.
export async function ynabGetAccount(env: Env, ynabAccountId: string): Promise<YNABAccountBalances | null> {
  try {
    const resp = await fetchWithRetry(
      `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/accounts/${ynabAccountId}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
      }
    );

    const data: any = await readJsonBody(resp);
    if (!resp.ok) return null;

    const a = data.data?.account;
    if (!a) return null;

    return {
      cleared_balance: Number(a.cleared_balance),
      uncleared_balance: Number(a.uncleared_balance),
      balance: Number(a.balance)
    };
  } catch {
    return null;
  }
}

export async function ynabDeleteTransaction(env: Env, transactionId: string): Promise<any> {
  const resp = await fetchWithRetry(
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions/${transactionId}`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
    }
  );

  const data: any = await readJsonBody(resp);

  // A retried DELETE can find the row already gone; that is the outcome we wanted.
  if (resp.status === 404) return { already_deleted: true };
  if (!resp.ok) {
    throw new Error(`YNAB transaction delete failed: ${resp.status} - ${JSON.stringify(data)}`);
  }

  return data;
}
