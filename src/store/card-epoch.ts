import { lookbackDate } from "../plaid/fetch";
import { getAccounts, isCreditCardAccount } from "./accounts";
import { Env } from "../types";
import { ynabGetAccountTransactions } from "../ynab/client";

// Bump a credit card's import-id epoch. Use after deleting the card's transactions in
// YNAB: YNAB permanently rejects import ids it has seen, so a fresh epoch lets
// bootstrap re-add the charges as new rows. Refuses while worker rows remain, because
// re-minting ids then would duplicate every charge (this has happened).
export async function resetCardEpoch(env: Env, url: URL): Promise<any> {
  const nickname = url.searchParams.get("account");
  if (!nickname) return { ok: false, error: "missing ?account=" };
  const acct = (await getAccounts(env)).find(a => a.nickname === nickname);
  if (!acct) return { ok: false, error: `no account named ${nickname}` };
  if (!isCreditCardAccount(acct)) return { ok: false, error: `${nickname} is not a credit card account` };
  if (url.searchParams.get("force") !== "true") {
    const existing = await ynabGetAccountTransactions(env, acct.ynab_account_id, lookbackDate(env));
    const workerRows = existing.filter(e => /^(pcc|pcp):/.test(e.import_id || ""));
    if (workerRows.length > 0) {
      return {
        ok: false, account: nickname, blocked: true, worker_rows_in_register: workerRows.length,
        error: "Register is not empty. Bumping the epoch now would duplicate every existing charge.",
        how_to_proceed: "Delete the card's transactions in YNAB first, then call /reset-card again. Or pass &force=true if you have already wiped it."
      };
    }
  }
  const key = `cc_epoch:${acct.plaid_account_id}`;
  const current = Number((await env.SYNC_STATE.get(key)) || "1");
  const next = String(current + 1);
  await env.SYNC_STATE.put(key, next);
  for (const k of [`links:${acct.plaid_account_id}`, `bootstrapped:${acct.plaid_account_id}`]) await env.SYNC_STATE.delete(k);
  return {
    ok: true, account: nickname, previous_epoch: String(current), new_epoch: next,
    note: "Import ids rotated. The next sync re-bootstraps this card and imports what is pending now."
  };
}
