import { readJson } from "../health/status";
import { plaidCall } from "../plaid/client";
import { getRecentRawTransactionsDetailed, lookbackDate, plaidItemCached, toIsoDate } from "../plaid/fetch";
import { PayeeAlias } from "../rules/payee-aliases";
import { getSkipRules } from "../rules/skip-rules";
import { getAuditedAccounts, isCreditCardAccount, settingForAccount } from "../store/accounts";
import { LINKS_KV_PREFIX, RoutingContext, isWorkerImportPrefix, loadRoutingContext, representPlaid } from "../sync/engine";
import { ALREADY_IN_YNAB_DATE_DAYS, CARD_PAYMENT_POSTING_DAYS, bankBalanceLag, daysApart, namesConflict, namesSimilar, normalizeMerchant } from "../sync/matching";
import { roundMoney } from "../sync/transfers";
import { AccountConfig, Env, PlaidTransaction, SkipRule, YNABExistingTransaction } from "../types";
import { dateInTimeZone, todayInTimeZone } from "../util/dates";
import { safePayee } from "../util/errors";
import { ynabGetAccount, ynabGetAccountTransactions } from "../ynab/client";

// ---------- Read-only transaction-level reconciliation (bank vs YNAB) ----------
//
// The acceptance test: does the YNAB register match the bank, row by row? This
// pulls Plaid (the bank truth) and the YNAB register for an account, matches them
// on amount + nearby date, and reports what exists on only one side:
//   ynab_only  = rows in YNAB with no bank counterpart  (the excess / phantom rows)
//   bank_only  = bank transactions missing from YNAB     (e.g. the Venmo deposit)
// It writes nothing. Amounts are dollars; outflows negative, matching YNAB signs.
// Uncleared YNAB legs of transfers into this account from your own (non-card)
// accounts, dated within the last 5 days, that no bank item here represents yet.
export function incomingInTransit(acct: AccountConfig, rows: YNABExistingTransaction[], represented: Set<string>, ctx: RoutingContext, today: string): YNABExistingTransaction[] {
  const senders = new Set(ctx.accounts.filter(a => a.nickname !== acct.nickname && !isCreditCardAccount(a)).map(a => a.ynab_account_id));
  // Any cleared status: you may mark the payment cleared (or reconcile) as soon as you
  // make it, while the card still shows it as "Payment Processing".
  return rows.filter(r => !represented.has(r.id) && !!r.transfer_transaction_id && Number(r.amount || 0) > 0 &&
    !!r.transfer_account_id && senders.has(r.transfer_account_id) && daysApart(r.date, today) <= 5);
}

// Posted bank charges whose YNAB row has a different amount. difference = YNAB - bank.
export function amountMismatches(plaid: PlaidTransaction[], rowByTx: Map<string, YNABExistingTransaction>): Array<{ transaction_id: string; date: string; payee: string; bank_amount: number; ynab_amount: number; difference: number; ynab_status: string }> {
  const out: any[] = [];
  for (const t of plaid) {
    const r = rowByTx.get(t.transaction_id);
    if (!r || t.pending) continue;
    const bank = Math.round(-t.amount * 1000), ynab = Number(r.amount || 0);
    if (bank === ynab) continue;
    out.push({ transaction_id: t.transaction_id, date: t.date, payee: r.payee_name || safePayee(t), bank_amount: roundMoney(bank / 1000), ynab_amount: roundMoney(ynab / 1000), difference: roundMoney((ynab - bank) / 1000), ynab_status: r.cleared || "" });
  }
  return out;
}

// A YNAB row one of your skip rules covers (a paycheck you enter ahead of the bank).
export function coveredBySkipRule(e: YNABExistingTransaction, acct: AccountConfig, skipRules: SkipRule[], aliases: PayeeAlias[]): boolean {
  const amt = Number(e.amount || 0);
  return skipRules.some(rule => {
    if (!rule.enabled) return false;
    if (rule.account !== "*" && rule.account !== acct.nickname) return false;
    if (rule.transaction_type === "inflow" && amt <= 0) return false;
    if (rule.transaction_type === "outflow" && amt >= 0) return false;
    if (Array.isArray(rule.amounts) && rule.amounts.length > 0) {
      return rule.amounts.some(x => Math.abs(Math.abs(amt) / 1000 - Number(x)) < 0.01);
    }
    return namesSimilar(normalizeMerchant(rule.contains), normalizeMerchant(e.payee_name || ""), aliases);
  });
}

export async function reconcileAccountVsBank(env: Env, acct: AccountConfig, days: number, ctx: RoutingContext, skipRules: SkipRule[]): Promise<any> {
  // Read the bank a week further back than the report shows. Matching runs over the
  // wider range, so a row just inside the window can still find its partner just
  // outside it (a card payment the bank dated 9/15 that you booked on 9/16). Only
  // rows inside the window are reported.
  const w = await getRecentRawTransactionsDetailed(env, acct, days + CARD_PAYMENT_POSTING_DAYS, 300);
  const windowStart = toIsoDate(new Date(Date.parse(`${w.start_date}T00:00:00Z`) + CARD_PAYMENT_POSTING_DAYS * 86400000));
  const plaidAll = w.transactions.filter(t => t.account_id === acct.plaid_account_id);
  const plaid = plaidAll.filter(t => t.date >= windowStart);
  // YNAB rows from the start of the bank read (a longer range than the sync's own
  // lookback when you pick 60 or 90 days).
  const lb = lookbackDate(env);
  const register = (await ynabGetAccountTransactions(env, acct.ynab_account_id, w.start_date < lb ? w.start_date : lb));
  const { rowByTx, specByTx } = await representPlaid(env, acct, plaidAll, register, ctx, skipRules);
  const matchedRowIds = new Set([...rowByTx.values()].map(r => r.id));

  const amountMismatch = amountMismatches(plaid, rowByTx);
  // On both sides, but YNAB and the bank disagree on whether it has posted. Cleared in
  // YNAB while the bank still shows it pending makes YNAB's cleared balance differ
  // from the bank's balance by that amount until the bank posts it.
  const statusRow = (t: PlaidTransaction, r: YNABExistingTransaction) => ({ date: t.date, payee: r.payee_name || t.merchant_name || t.name || "", amount: roundMoney(Number(r.amount || 0) / 1000), ynab_status: r.cleared, bank_status: t.pending ? "pending" : "posted" });
  const clearedButPending: any[] = [];
  const postedButUncleared: any[] = [];
  for (const t of plaid) {
    const r = rowByTx.get(t.transaction_id);
    if (!r) continue;
    if (t.pending && r.cleared !== "uncleared") clearedButPending.push(statusRow(t, r));
    else if (!t.pending && r.cleared === "uncleared") postedButUncleared.push(statusRow(t, r));
  }
  const bankOnly: any[] = [];
  const skippedByRule: any[] = [];
  const pendingForDirectImport: any[] = [];
  const workerSyncs = settingForAccount(ctx.settings, acct).sync_enabled;
  for (const t of plaid) {
    if (rowByTx.has(t.transaction_id)) continue;
    const spec = specByTx.get(t.transaction_id);
    const item = { date: t.date, name: t.merchant_name || t.name || "", amount: roundMoney(-t.amount), pending: !!t.pending, reason: spec?.skip || null };
    // Charges the worker deliberately does not import are listed separately, so they
    // are not mistaken for missing transactions. So are pending charges on an account
    // Direct Import feeds: they arrive once they post.
    if (spec?.skip) skippedByRule.push(item);
    else if (!workerSyncs && t.pending) pendingForDirectImport.push(item);
    else bankOnly.push(item);
  }
  // Only YNAB rows inside the bank window can be judged; older rows are outside it.
  // YNAB's own "Reconciliation Balance Adjustment" rows aren't bank transactions;
  // list them separately rather than as unmatched.
  const isAdjustment = (r: YNABExistingTransaction) => /^(reconciliation balance adjustment|starting balance)$/i.test(String(r.payee_name || "").trim());
  const adjustments = register
    .filter(r => r.date >= windowStart && !matchedRowIds.has(r.id) && isAdjustment(r))
    .map(r => ({ date: r.date, payee: r.payee_name, amount: roundMoney(Number(r.amount || 0) / 1000), cleared: r.cleared }));
  // A row you entered ahead of the bank that your skip rules cover (a paycheck), and
  // the bank feed hasn't shown yet: expected, listed on its own. Once the bank shows
  // it, it's matched like anything else.
  const today = todayInTimeZone(env);
  const aheadIds = new Set(register.filter(r => r.date >= windowStart && !matchedRowIds.has(r.id) && !isAdjustment(r) &&
    daysApart(r.date, today) <= 5 && coveredBySkipRule(r, acct, skipRules, ctx.aliases)).map(r => r.id));
  const enteredAhead = register.filter(r => aheadIds.has(r.id))
    .map(r => ({ date: r.date, payee: r.payee_name, amount: roundMoney(Number(r.amount || 0) / 1000), cleared: r.cleared }));
  // The bank feed (Plaid) usually runs hours to a day behind the bank's own app. A
  // YNAB row dated on or after the feed's last update can simply be newer than the
  // feed; it's listed separately with the feed's time instead of as a problem.
  let feedUpdatedAt: string | null = null;
  try {
    const item = await plaidItemCached(env, acct.plaid_access_token);
    feedUpdatedAt = item.status?.transactions?.last_successful_update || null;
  } catch { /* unknown: nothing is treated as too new */ }
  const feedDay = feedUpdatedAt ? dateInTimeZone(env, feedUpdatedAt) : "";
  const tooNewIds = new Set(feedDay ? register.filter(r => r.date >= windowStart && r.date >= feedDay && !matchedRowIds.has(r.id) && !isAdjustment(r) && !aheadIds.has(r.id)).map(r => r.id) : []);
  // Money on its way in from your other account (booked when the sender showed it
  // pending; this bank hasn't shown it yet).
  const cardTied = new Set<string>(Object.values(await readJson(env, `${LINKS_KV_PREFIX}${acct.plaid_account_id}`, {})).map(String));
  const onTheWayRows = incomingInTransit(acct, register.filter(r => r.date >= windowStart && !aheadIds.has(r.id)), matchedRowIds, ctx, today)
    .filter(r => !(r.cleared !== "uncleared" && cardTied.has(r.id)));
  for (const r of onTheWayRows) tooNewIds.delete(r.id);
  const onTheWayIds = new Set(onTheWayRows.map(r => r.id));
  const onTheWay = onTheWayRows.map(r => ({ date: r.date, payee: r.payee_name, amount: roundMoney(Number(r.amount || 0) / 1000), cleared: r.cleared }));
  const tooNew = register.filter(r => tooNewIds.has(r.id))
    .map(r => ({ date: r.date, payee: r.payee_name, amount: roundMoney(Number(r.amount || 0) / 1000), cleared: r.cleared }));
  const ynabOnly = register
    .filter(r => r.date >= windowStart && !matchedRowIds.has(r.id) && !isAdjustment(r) && !aheadIds.has(r.id) && !tooNewIds.has(r.id) && !onTheWayIds.has(r.id))
    .map(r => ({
      date: r.date,
      payee: r.payee_name || (r.transfer_transaction_id ? "(transfer)" : ""),
      amount: roundMoney(Number(r.amount || 0) / 1000),
      cleared: r.cleared,
      is_transfer: !!r.transfer_transaction_id,
      worker_created: isWorkerImportPrefix(r.import_id)
    }));

  // Same transaction on both sides but in opposite directions (the bank says $70 came
  // in, YNAB says $70 went out). Never matched as "the same", because the balances
  // really do differ by twice the amount, but listed together so it's obvious it is
  // one transaction with the direction wrong on one side, not two missing ones.
  const directionMismatch: any[] = [];
  for (const b of [...bankOnly]) {
    const cands = ynabOnly.filter(y => !y.is_transfer && Math.abs(y.amount + b.amount) < 0.005 && Math.abs(y.amount) > 0.005 &&
      daysApart(y.date, b.date) <= ALREADY_IN_YNAB_DATE_DAYS &&
      !namesConflict(normalizeMerchant(b.name), normalizeMerchant(y.payee), ctx.aliases));
    if (cands.length !== 1) continue;
    const y = cands[0];
    directionMismatch.push({ date: b.date, name: b.name, bank_amount: b.amount, ynab_payee: y.payee, ynab_date: y.date, ynab_amount: y.amount, ynab_status: y.cleared, balance_effect: roundMoney(y.amount - b.amount) });
    bankOnly.splice(bankOnly.indexOf(b), 1);
    ynabOnly.splice(ynabOnly.indexOf(y), 1);
  }

  const sum = (arr: any[]) => roundMoney(arr.reduce((acc, x) => acc + x.amount, 0));

  // Balance check: YNAB's cleared balance against the bank's posted balance, now and
  // as of the first day of this view. When the two already differed on that first
  // day, the difference is older than the view, and no list here can show it.
  let balanceCheck: any = null;
  try {
    const bal = await plaidCall(env, "/accounts/balance/get", { access_token: acct.plaid_access_token });
    const ba = (bal.accounts || []).find((x: any) => x.account_id === acct.plaid_account_id);
    const ya = await ynabGetAccount(env, acct.ynab_account_id);
    const cur = Number(ba?.balances?.current);
    if (Number.isFinite(cur) && ya && Number.isFinite(ya.cleared_balance)) {
      const bankNow = roundMoney(isCreditCardAccount(acct) ? -cur : cur);
      const ynabNow = roundMoney(Number(ya.cleared_balance) / 1000);
      const bankInWindow = roundMoney(plaid.filter(t => !t.pending).reduce((s, t) => s - Number(t.amount || 0), 0));
      const ynabInWindow = roundMoney(register.filter(r => r.date >= windowStart && r.cleared !== "uncleared").reduce((s, r) => s + Number(r.amount || 0) / 1000, 0));
      const diffNow = roundMoney(ynabNow - bankNow);
      const diffAtStart = roundMoney((ynabNow - ynabInWindow) - (bankNow - bankInWindow));
      let note: string;
      const lag = bankBalanceLag(diffNow, plaid, todayInTimeZone(env));
      if (Math.abs(diffNow) <= 0.01) note = "YNAB's cleared balance matches the bank's posted balance.";
      else if (Math.abs(diffAtStart - diffNow) <= 0.01) note = `The whole difference was already there before ${windowStart}, the first day this view covers, so nothing listed here can explain it. Run a longer range to find where it starts.`;
      else if (Math.abs(diffAtStart) <= 0.01) note = `The difference started on or after ${windowStart}; the lists below should account for it.`;
      else note = `Part of the difference (${diffAtStart.toFixed(2)}) was already there before ${windowStart}; the rest started in this range.`;
      // A gap equal to what just posted is most likely the bank's balance lagging; the
      // range-based reading stays alongside in case it's a coincidence.
      if (lag) note = `${lag} If it's still off after that: ${note.charAt(0).toLowerCase()}${note.slice(1)}`;
      balanceCheck = { bank_posted: bankNow, ynab_cleared: ynabNow, difference: diffNow, difference_at_start: diffAtStart, likely_balance_lag: !!lag, note };
    }
  } catch { /* balance unavailable: the lists still stand on their own */ }

  return {
    account: acct.nickname,
    balance_check: balanceCheck,
    direction_mismatch: directionMismatch,
    direction_mismatch_count: directionMismatch.length,
    window_start: windowStart,
    truncated: w.truncated,
    ynab_register_count: register.filter(r => r.date >= windowStart).length,
    bank_count: plaid.length,
    ynab_only_count: ynabOnly.length,
    ynab_only_total: sum(ynabOnly),
    ynab_only: ynabOnly,
    bank_only_count: bankOnly.length,
    bank_only_total: sum(bankOnly),
    bank_only: bankOnly,
    bank_pending_direct_import: pendingForDirectImport,
    bank_skipped_count: skippedByRule.length,
    bank_skipped: skippedByRule,
    ynab_adjustments: adjustments,
    ynab_entered_ahead: enteredAhead,
    amount_mismatch: amountMismatch,
    amount_mismatch_count: amountMismatch.length,
    amount_mismatch_total: roundMoney(amountMismatch.reduce((s, m) => s + m.difference, 0)),
    ynab_newer_than_feed: tooNew,
    ynab_on_the_way: onTheWay,
    cleared_but_pending: clearedButPending,
    cleared_but_pending_total: roundMoney(clearedButPending.reduce((s, x) => s + x.amount, 0)),
    posted_but_uncleared: postedButUncleared,
    feed_updated_at: feedUpdatedAt
  };
}

export async function reconcileAllVsBank(env: Env, days: number, accountNickname?: string): Promise<any> {
  const accts = await getAuditedAccounts(env);
  const targets = accountNickname ? accts.filter(a => a.nickname === accountNickname) : accts;
  if (accountNickname && targets.length === 0) return { ok: false, error: `'${accountNickname}' is not mapped or has health checks turned off.`, results: [] };
  const ctx = await loadRoutingContext(env);
  const skipRules = await getSkipRules(env);
  const results: any[] = [];
  for (const a of targets) {
    try { results.push(await reconcileAccountVsBank(env, a, days, ctx, skipRules)); }
    catch (e: any) { results.push({ account: a.nickname, error: e.message }); }
  }
  return reconciliationSummary(results, days);
}


// A report is complete only when every selected account completed without errors,
// truncated bank history, or unavailable balance data.
export function reconciliationSummary(results: any[], days: number): any {
  const failures = results.filter(r => !!r.error);
  const incomplete = results.filter(r => !r.error && (r.truncated === true || r.balance_check == null));
  const status = results.length === 0 || failures.length === results.length ? "failed"
    : failures.length > 0 || incomplete.length > 0 ? "partial"
    : "complete";
  return {
    ok: status === "complete",
    complete: status === "complete",
    status,
    ts: new Date().toISOString(),
    days,
    summary: { accounts: results.length, failed: failures.length, incomplete: incomplete.length },
    results
  };
}
