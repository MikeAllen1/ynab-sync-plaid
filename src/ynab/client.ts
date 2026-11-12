import { runCache } from "../plaid/fetch";
import { Env, YNABAccountSummary, YNABExistingTransaction, YNABTransaction } from "../types";
import { fetchWithRetry, readJsonBody } from "../util/http";
import { reserveYnabRequest } from "../lock/lock";

async function ynabFetchWithRetry(env: Env, url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, 2, { beforeAttempt: () => reserveYnabRequest(env) });
}

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
  const resp = await ynabFetchWithRetry(env,
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

  const created = data?.data?.transaction_ids;
  const duplicates = data?.data?.duplicate_import_ids;
  if (!Array.isArray(created) || !Array.isArray(duplicates) ||
      !created.every((id: unknown) => typeof id === "string") ||
      !duplicates.every((id: unknown) => typeof id === "string")) {
    throw new Error("YNAB upsert returned HTTP success with an invalid transaction result envelope; write outcome is unknown.");
  }
  return {
    added: created.length,
    duplicates: duplicates.length,
    created_ids: created,
    duplicate_import_ids: duplicates
  };
}

// Bulk in-place update (PATCH). Each entry MUST carry the YNAB transaction `id`.
// Only the fields included are changed; anything omitted (payee_name, category,
// approved, memo) is left as-is, so a user's rename/category survives a pending->
// posted flip. Used by the single-feed credit-card sync to settle a row in place.
export async function ynabUpdateTransactions(env: Env, updates: any[]): Promise<{ updated: number }> {
  if (updates.length === 0) return { updated: 0 };
  const resp = await ynabFetchWithRetry(env,
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

  const updatedIds = data?.data?.transaction_ids;
  if (!Array.isArray(updatedIds) || !updatedIds.every((id: unknown) => typeof id === "string")) {
    throw new Error("YNAB update returned an invalid success response: transaction_ids is required and must be an array of strings; update outcome is unknown.");
  }
  const confirmed = new Set(updatedIds);
  const missing = updates.map(u => String(u.id)).filter(id => !confirmed.has(id));
  if (missing.length > 0) {
    throw new Error(`YNAB update response did not confirm ${missing.length} of ${updates.length} requested transaction id(s)`);
  }
  return { updated: updates.length };
}


// Updates in one request; if YNAB refuses the batch, retry row by row so one bad row
// (a split parent whose amount can't change, say) doesn't block every other update
// and retirement for the account. Rows that still fail are returned, not thrown.
function ynabRowMatchesUpdate(row: any, update: any): boolean {
  if (!row || row.id !== update.id) return false;
  for (const [key, value] of Object.entries(update)) {
    if (key === "id" || key === "import_id") continue;
    if (JSON.stringify(row[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

// Apply definitive validation rejections row-by-row. For ambiguous outcomes,
// read back every row first, then patch only rows whose requested fields are not
// present. A lost response after commit is therefore recovered without blindly
// replaying the batch or duplicating a financial mutation.
export async function ynabUpdateEach(env: Env, updates: any[]): Promise<{ updated: number; failed: { id: string; error: string }[] }> {
  if (updates.length === 0) return { updated: 0, failed: [] };
  try {
    return { ...(await ynabUpdateTransactions(env, updates)), failed: [] };
  } catch (batchError: any) {
    const message = String(batchError?.message || batchError);
    if (/^YNAB update failed: 400\b/.test(message)) {
      if (updates.length === 1) return { updated: 0, failed: [{ id: updates[0].id, error: message }] };
      let updated = 0;
      const failed: { id: string; error: string }[] = [];
      for (const update of updates) {
        try { updated += (await ynabUpdateTransactions(env, [update])).updated; }
        catch (error: any) { failed.push({ id: update.id, error: String(error?.message || error) }); }
      }
      return { updated, failed };
    }

    // The batch may have committed before its response was lost. Read back all
    // requested rows before deciding which individual PATCHes are still needed.
    let currentRows: Array<YNABExistingTransaction | null>;
    try {
      currentRows = await Promise.all(updates.map(update => ynabGetTransaction(env, String(update.id))));
    } catch {
      throw batchError;
    }
    let updated = 0;
    const failed: { id: string; error: string }[] = [];
    for (let index = 0; index < updates.length; index++) {
      const update = updates[index];
      if (ynabRowMatchesUpdate(currentRows[index], update)) {
        updated++;
        continue;
      }
      try {
        updated += (await ynabUpdateTransactions(env, [update])).updated;
      } catch (error: any) {
        // A single-row PATCH can also lose its response; confirm its final state
        // before reporting failure. If read-back fails, preserve the unknown outcome.
        const after = await ynabGetTransaction(env, String(update.id));
        if (ynabRowMatchesUpdate(after, update)) updated++;
        else failed.push({ id: update.id, error: String(error?.message || error) });
      }
    }
    return { updated, failed };
  }
}

export async function ynabGetAccounts(env: Env): Promise<YNABAccountSummary[]> {
  const hit = runCache.get("ynab_accounts");
  if (hit) return hit;
  const list = await ynabGetAccountsUncached(env);
  runCache.set("ynab_accounts", list);
  return list;
}

export async function ynabGetAccountsUncached(env: Env): Promise<YNABAccountSummary[]> {
  const resp = await ynabFetchWithRetry(env,
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

  if (!Array.isArray(data?.data?.accounts)) throw new Error("YNAB accounts returned HTTP success with an invalid response envelope.");
  return data.data.accounts;
}

export async function ynabGetTransaction(env: Env, id: string): Promise<YNABExistingTransaction | null> {
  const resp = await ynabFetchWithRetry(env, `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions/${encodeURIComponent(id)}`, {
    method: "GET", headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
  });
  if (resp.status === 404) return null;
  const data: any = await readJsonBody(resp);
  if (!resp.ok) throw new Error(`YNAB transaction read failed: ${resp.status} - ${JSON.stringify(data)}`);
  if (!data?.data?.transaction || typeof data.data.transaction.id !== "string") {
    throw new Error("YNAB transaction read returned HTTP success with an invalid response envelope.");
  }
  return data.data.transaction;
}

export async function ynabGetAccountTransactions(env: Env, ynabAccountId: string, sinceDate?: string): Promise<YNABExistingTransaction[]> {
  // since_date dramatically cuts payload and rate-limit cost: instead of pulling
  // an account's entire history on every call, we only read recent transactions
  // (pending charges clear within days). Balances for reconciliation come from
  // ynabGetAccount, so nothing that needs full history relies on this list.
  const query = sinceDate ? `?since_date=${encodeURIComponent(sinceDate)}` : "";
  const resp = await ynabFetchWithRetry(env,
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

  if (!Array.isArray(data?.data?.transactions)) throw new Error("YNAB account transactions returned HTTP success with an invalid response envelope.");
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
  const resp = await ynabFetchWithRetry(env,
    `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/accounts/${encodeURIComponent(ynabAccountId)}`,
    {
      method: "GET",
      headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
    }
  );
  if (resp.status === 404) return null;
  const data: any = await readJsonBody(resp);
  if (!resp.ok) {
    throw new Error(`YNAB account read failed: ${resp.status} - ${JSON.stringify(data)}`);
  }
  const a = data?.data?.account;
  if (!a || ![a.cleared_balance, a.uncleared_balance, a.balance].every(Number.isSafeInteger)) {
    throw new Error("YNAB account read returned HTTP success with missing or invalid milliunit balances.");
  }
  return {
    cleared_balance: a.cleared_balance,
    uncleared_balance: a.uncleared_balance,
    balance: a.balance
  };
}

export async function ynabDeleteTransaction(env: Env, transactionId: string): Promise<any> {
  const resp = await ynabFetchWithRetry(env,
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

/** Read back both sides of a YNAB transfer. A successful create response alone
 * does not prove that the paired register row points to the intended account. */
export async function ynabVerifyTransferPair(
  env: Env,
  transactionId: string,
  sourceAccountId: string,
  targetAccountId: string,
  expectedAmount: number
): Promise<void> {
  const source = await ynabGetTransaction(env, transactionId);
  if (!source) throw new Error(`YNAB transfer verification failed: source transaction ${transactionId} is missing.`);
  if (source.account_id !== sourceAccountId || Number(source.amount) !== expectedAmount ||
      !source.transfer_transaction_id || source.transfer_account_id !== targetAccountId) {
    throw new Error(`YNAB transfer verification failed: source transaction ${transactionId} is not paired to the expected account and amount.`);
  }
  const target = await ynabGetTransaction(env, source.transfer_transaction_id);
  if (!target || target.id !== source.transfer_transaction_id ||
      target.account_id !== targetAccountId || target.transfer_account_id !== sourceAccountId ||
      target.transfer_transaction_id !== source.id || Number(target.amount) !== -expectedAmount) {
    throw new Error(`YNAB transfer verification failed: paired transaction for ${transactionId} is missing or inconsistent.`);
  }
}

/** Read the destination plan's configured ISO currency. Cached for this Worker run. */
export async function ynabGetPlanCurrency(env: Env): Promise<string> {
  const cacheKey = "ynab_plan_currency";
  const cached = runCache.get(cacheKey);
  if (cached) return cached;
  const resp = await ynabFetchWithRetry(env,
    `https://api.ynab.com/v1/plans/${encodeURIComponent(env.YNAB_BUDGET_ID)}/settings`,
    { method: "GET", headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` } }
  );
  const data: any = await readJsonBody(resp);
  if (!resp.ok) throw new Error(`YNAB plan settings failed: ${resp.status} - ${JSON.stringify(data)}`);
  const currency = data?.data?.settings?.currency_format?.iso_code;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("YNAB plan settings returned no valid ISO currency code; transaction writes were blocked.");
  }
  runCache.set(cacheKey, currency);
  return currency;
}

export async function ynabGetDeletedAccountTransactions(env: Env, ynabAccountId: string, sinceDate: string): Promise<any[]> {
  const url = `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/accounts/${encodeURIComponent(ynabAccountId)}/transactions?since_date=${encodeURIComponent(sinceDate)}&last_knowledge_of_server=1`;
  const resp = await ynabFetchWithRetry(env, url, {
    method: "GET", headers: { "Authorization": `Bearer ${env.YNAB_TOKEN}` }
  });
  const data: any = await readJsonBody(resp);
  if (!resp.ok) throw new Error(`YNAB deleted transaction read failed: ${resp.status} - ${JSON.stringify(data)}`);
  if (!Array.isArray(data?.data?.transactions)) throw new Error("YNAB deleted transaction read returned an invalid response envelope.");
  return data.data.transactions;
}
