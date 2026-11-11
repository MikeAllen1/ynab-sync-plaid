import { amountMismatches, coveredBySkipRule, incomingInTransit } from "./reconcile";
import { AUDIT_DAYS, BALANCE_RECONCILIATION_DAYS, STALE_PENDING_DAYS, WORKER_VERSION } from "../constants";
import { captureStuckPending } from "../health/items";
import { readJson, status } from "../health/status";
import { plaidCall } from "../plaid/client";
import { getRecentRawTransactionsDetailed, lookbackDate } from "../plaid/fetch";
import { getSkipRules } from "../rules/skip-rules";
import { accountParam, getAccountAutomationSettings, getAuditedAccounts, isCreditCardAccount, settingForAccount } from "../store/accounts";
import { LINKS_KV_PREFIX, RoutingContext, expectedPendingImportId, isHeldTransferKind, isInSideKind, isWorkerPendingRow, lifecycleKey, loadRoutingContext, representPlaid } from "../sync/engine";
import { CARD_PAYMENT_POSTING_DAYS, bankBalanceLag, daysApart, getCcEpoch, namesConflict, normalizeMerchant, plaidPayeeText } from "../sync/matching";
import { roundMoney, summarizeYnabExisting } from "../sync/transfers";
import { AccountConfig, Env, PlaidTransaction, SkipRule, YNABAccountSummary, YNABExistingTransaction } from "../types";
import { isStalePendingCandidate, todayInTimeZone } from "../util/dates";
import { friendlyErrorMessage, safePayee } from "../util/errors";
import { YNABAccountBalances, ynabGetAccount, ynabGetAccountTransactions, ynabGetAccounts } from "../ynab/client";

// ---------- Account audit ----------

export interface AccountAudit {
  account: string;
  ynab_account_id: string;
  plaid_account_id: string;
  raw_days: number;
  stale_days: number;
  ynab_uncleared_count: number;
  ynab_uncleared_total: number;
  plaid_pending_count: number;
  plaid_pending_total: number;
  plaid_pending_transfer_total?: number;
  plaid_pending_transfer_count?: number;
  plaid_pending_total_all?: number;
  difference: number;
  bank_balance?: number | null;
  ynab_balance?: number | null;
  balance_difference?: number | null;
  expected_difference?: number;
  unexplained_difference?: number | null;
  explained_difference?: number;
  explained_by?: string | null;
  attention_reasons?: string[];
  cleared_difference?: number | null;
  amount_mismatch?: any[];
  unlisted_pending_hold?: number | null;
  posted_but_uncleared?: Array<{ date: string; payee: string; amount: number }>;
  balance_match?: boolean | null;
  balance_source?: string | null;
  missing_balance_transactions?: Array<{
    source: "bank" | "ynab" | "amount";
    transaction_id: string;
    date: string;
    payee: string;
    amount: number;
    pending: boolean;
    confidence: "exact_delta" | "delta_combination" | "possible";
  }>;
  missing_balance_transaction_count?: number;
  pending_purchase_count_covered?: number;
  pending_purchase_count_total?: number;
  pending_variance?: number;
  worker_pending_count: number;
  stale_pending_count: number;
  ynab_cleared_total: number;
  pending_accuracy_pct?: number;
  plaid_pending_unmatched_count?: number;
  plaid_pending_unmatched_ids?: string[];
  ynab_pending_represented_total?: number;
  positive_credit_balance: boolean;
  stale_pending_candidates: any[];
  warnings: string[];
  notes?: string[];
  status: "healthy" | "warning" | "needs_attention";
  audit_unavailable?: boolean;
  worker_syncs?: boolean;
}

export async function runAccountAudit(env: Env, days = AUDIT_DAYS, staleDays = STALE_PENDING_DAYS, accountNickname?: string): Promise<any> {
  const accounts = await getAuditedAccounts(env);
  const selected = accountNickname ? accounts.filter(a => a.nickname === accountNickname) : accounts;
  const automation = await getAccountAutomationSettings(env);

  if (accountNickname && selected.length === 0) {
    return { ok: false, error: `'${accountNickname}' is not mapped or has health checks turned off.`, valid_accounts: accounts.map(a => a.nickname) };
  }

  const sinceDate = lookbackDate(env);
  const ynabAccounts = await ynabGetAccounts(env);
  const ctx = await loadRoutingContext(env);
  const skipRules = await getSkipRules(env);
  // null = the read FAILED. Never substitute an empty register: an empty register
  // would make every bank transaction look missing from YNAB.
  const transactionCache: Record<string, YNABExistingTransaction[] | null> = {};
  const accountBalanceCache: Record<string, YNABAccountBalances | null> = {};

  for (const acct of accounts) {
    try {
      transactionCache[acct.ynab_account_id] = await ynabGetAccountTransactions(env, acct.ynab_account_id, sinceDate);
    } catch {
      transactionCache[acct.ynab_account_id] = null;
    }

    try {
      accountBalanceCache[acct.ynab_account_id] = await ynabGetAccount(env, acct.ynab_account_id);
    } catch {
      accountBalanceCache[acct.ynab_account_id] = null;
    }
  }

  // One real-time balance call per bank login (accounts sharing a login share it).
  const balanceByToken = new Map<string, Promise<any>>();
  const balancesFor = (token: string) => {
    if (!balanceByToken.has(token)) balanceByToken.set(token, plaidCall(env, "/accounts/balance/get", { access_token: token }));
    return balanceByToken.get(token)!;
  };

  const audits: AccountAudit[] = [];

  for (const acct of selected) {
    try {
      const workerSyncs = settingForAccount(automation, acct).sync_enabled;
      audits.push(await auditAccount(env, acct, days, staleDays, accounts, transactionCache, accountBalanceCache, ynabAccounts, ctx, skipRules, balancesFor, workerSyncs));
    } catch (e: any) {
      // A single account's Plaid read failing during the (read-only) audit must not
      // freeze a scary "token revoked / needs attention" banner across the dashboard.
      // Degrade to a soft warning; the live sync path owns real token-failure surfacing.
      audits.push({
        account: acct.nickname,
        ynab_account_id: acct.ynab_account_id,
        plaid_account_id: acct.plaid_account_id,
        raw_days: days,
        stale_days: staleDays,
        ynab_uncleared_count: 0,
        ynab_uncleared_total: 0,
        plaid_pending_count: 0,
        plaid_pending_total: 0,
        difference: 0,
        worker_pending_count: 0,
        stale_pending_count: 0,
        ynab_cleared_total: 0,
        positive_credit_balance: false,
        stale_pending_candidates: [],
        warnings: [`Audit data unavailable this run (${friendlyErrorMessage(e)}). This is a read-only check; sync status is reported separately.`],
        status: "warning",
        audit_unavailable: true
      });
    }
  }

  // Save an explanation for any worker pending row that should have moved to posted
  // but didn't, so the evidence is there even after you fix the row by hand.
  for (const acct of selected) {
    if (!settingForAccount(automation, acct).sync_enabled) continue;
    const a = audits.find(x => x.account === acct.nickname);
    // No audit data this run: nothing is known about the rows, so nothing is resolved.
    if (!a || a.audit_unavailable) continue;
    // (The register the health check just read is reused: same YNAB data, one fewer call.)
    try { await captureStuckPending(env, acct, (a?.worker_pending_count || 0) > 0, transactionCache[acct.ynab_account_id]); }
    catch (e: any) {
      // Diagnostics never break the audit, but a failure here is recorded, not hidden.
      try { await env.SYNC_STATE.put("last_stuck_check_error", JSON.stringify({ ts: new Date().toISOString(), account: acct.nickname, error: friendlyErrorMessage(e) })); } catch { /* ignore */ }
    }
  }

  const needsAttention = audits.filter(a => a.status === "needs_attention").length;
  const warnings = audits.filter(a => a.status === "warning").length;

  const result = {
    ok: needsAttention === 0,
    ts: new Date().toISOString(),
    worker_version: WORKER_VERSION,
    days,
    stale_days: staleDays,
    summary: {
      healthy: audits.filter(a => a.status === "healthy").length,
      warning: warnings,
      needs_attention: needsAttention
    },
    audits,
    note: "Audit compares bank-vs-YNAB balance parity as the primary health signal, then separately reports pending-purchase coverage, payment-looking issues, and stale Worker-created pending imports. It does not change YNAB."
  };

  for (const a of audits) (a as any).checked_at = result.ts;
  if (!accountNickname) {
    await env.SYNC_STATE.put("last_account_audit", JSON.stringify(result));
  } else {
    // A single-account check replaces only that account's entry in the stored result,
    // so the dashboard, the headline and alerts all see the fresh answer.
    const stored = await readJson(env, "last_account_audit", null);
    if (stored && Array.isArray(stored.audits)) {
      const merged = [...stored.audits.filter((a: any) => !audits.some(x => x.account === a.account)), ...audits];
      const summary = {
        healthy: merged.filter((a: any) => a.status === "healthy").length,
        warning: merged.filter((a: any) => a.status === "warning").length,
        needs_attention: merged.filter((a: any) => a.status === "needs_attention").length
      };
      await env.SYNC_STATE.put("last_account_audit", JSON.stringify({ ...stored, ok: summary.needs_attention === 0, summary, audits: merged }));
    }
  }
  return result;
}

export async function auditAccounts(env: Env, url: URL): Promise<any> {
  const accountParam = url.searchParams.get("account") || undefined;
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") || AUDIT_DAYS)));
  const staleDays = Math.max(1, Math.min(30, Number(url.searchParams.get("staleDays") || STALE_PENDING_DAYS)));

  return await runAccountAudit(env, days, staleDays, accountParam);
}

export async function auditAccount(
  env: Env,
  acct: AccountConfig,
  days: number,
  staleDays: number,
  allAccounts: AccountConfig[] = [],
  transactionCache: Record<string, YNABExistingTransaction[] | null> = {},
  accountBalanceCache: Record<string, YNABAccountBalances | null> = {},
  ynabAccounts: YNABAccountSummary[] = [],
  ctx?: RoutingContext,
  skipRules: SkipRule[] = [],
  balancesFor?: (token: string) => Promise<any>,
  workerSyncs = true
): Promise<AccountAudit> {
  const sinceDate = lookbackDate(env);
  const todayStr = todayInTimeZone(env);
  const cached = transactionCache[acct.ynab_account_id];
  if (cached === null) throw new Error("YNAB transaction data unavailable; reconciliation incomplete");
  const existing = cached || await ynabGetAccountTransactions(env, acct.ynab_account_id, sinceDate);
  const routing = ctx || await loadRoutingContext(env);
  const account = acct.ynab_account_id in accountBalanceCache
    ? accountBalanceCache[acct.ynab_account_id]
    : await ynabGetAccount(env, acct.ynab_account_id);
  const rawWindow = await getRecentRawTransactionsDetailed(env, acct, Math.max(days, BALANCE_RECONCILIATION_DAYS), 100);
  const raw = rawWindow.transactions.filter(t => t.account_id === acct.plaid_account_id);
  const epoch = isCreditCardAccount(acct) ? await getCcEpoch(env, acct.plaid_account_id) : "";
  const { rowByTx, specByTx } = await representPlaid(env, acct, raw, existing, routing, skipRules);

  const plaidPending = raw.filter(t => t.pending);
  // Pending card payments and internal account-to-account transfers wash out — they
  // are money moving between your own accounts, not spending — so counting them as
  // pending purchases produces a phantom variance (e.g. a payment to the card, or a
  // transfer out and back). Exclude them on every account type and compare only
  // genuine pending purchases. On credit cards we also suppress the pending warning
  // outright below: a single-feed card is anchored by reconciling to the bank, so a
  // pending-sum comparison has no job there and only generates false alarms.
  const isCardAccount = isCreditCardAccount(acct);
  // Only card payments are excluded: the sync deliberately books those once posted.
  // Other pending transfers ARE imported as pending rows, so they count.
  const plaidPendingTransfers = plaidPending.filter(t => {
    const k = specByTx.get(t.transaction_id)?.skipKind;
    return isHeldTransferKind(k) || isInSideKind(k);
  });
  const transferIds = new Set(plaidPendingTransfers.map(t => t.transaction_id));
  const plaidPendingPurchases = plaidPending.filter(t => !transferIds.has(t.transaction_id));
  // Every charge the bank still shows, pending OR posted: a posted charge keeps its
  // pending row's identity (lifecycle key) until the next sync flips it, so that row
  // is not stale.
  const plaidPendingImportIds = new Set(raw.map(t => expectedPendingImportId(acct, lifecycleKey(t), epoch)));
  const plaidPendingTotal = roundMoney(plaidPendingPurchases.reduce((sum, t) => sum + (-t.amount), 0));
  const plaidPendingTransferTotal = roundMoney(plaidPendingTransfers.reduce((sum, t) => sum + (-t.amount), 0));
  const plaidPendingTotalAll = roundMoney(plaidPending.reduce((sum, t) => sum + (-t.amount), 0));

  const ynabUncleared = existing.filter(t => t.cleared === "uncleared");
  // Totals come from the account's authoritative balances (full history) so they
  // stay exact even though we only fetch recent transactions for detection. Fall
  // back to summing the windowed list if the account object is unavailable.
  const ynabUnclearedTotal = account && Number.isFinite(account.uncleared_balance)
    ? roundMoney((account.uncleared_balance as number) / 1000)
    : roundMoney(ynabUncleared.reduce((sum, t) => sum + (Number(t.amount || 0) / 1000), 0));
  const ynabClearedTotal = account && Number.isFinite(account.cleared_balance)
    ? roundMoney((account.cleared_balance as number) / 1000)
    : roundMoney(existing.filter(t => t.cleared === "cleared" || t.cleared === "reconciled").reduce((sum, t) => sum + (Number(t.amount || 0) / 1000), 0));
  // Balance parity is the primary account-health signal. Pending coverage remains
  // a separate diagnostic because YNAB's uncleared population can contain more than
  // pending purchases (for example transfers and manually entered rows).
  // PRIMARY HEALTH: compare the actual bank balance with YNAB's working balance.
  // Checking uses Plaid available because pending holds are already reflected there.
  // Credit cards use posted bank balance + current pending activity, expressed in
  // YNAB's signed card-account convention.
  // Comparison basis. When the worker syncs this account, YNAB holds pending rows
  // too, so YNAB's full balance is compared with the bank's posted balance adjusted
  // for pending. When it doesn't (Direct Import writes it), YNAB only ever gets
  // posted charges, so YNAB's CLEARED balance is compared with the bank's POSTED
  // balance and pending charges are not expected in YNAB at all.
  let bankBalance: number | null = null;
  let bankPostedBalance: number | null = null; // posted only, in YNAB's sign convention
  let unlistedHold = 0; // money the bank is holding for pending items the feed doesn't list
  const ynabBalance: number | null = !workerSyncs
    ? (account && Number.isFinite(account.cleared_balance) ? roundMoney(account.cleared_balance / 1000) : null)
    : (account && Number.isFinite(account.balance) ? roundMoney(account.balance / 1000) : null);
  const positiveCreditBalance = isCreditCardAccount(acct) && ynabBalance != null
    ? ynabBalance > 0.01
    : false;
  let balanceDifference: number | null = null;
  let balanceMatch: boolean | null = null;
  let balanceSource: string | null = null;
  const missingBalanceTransactions: Array<{
    source: "bank" | "ynab" | "amount";
    transaction_id: string;
    date: string;
    payee: string;
    amount: number;
    pending: boolean;
    confidence: "exact_delta" | "delta_combination" | "possible";
  }> = [];

  try {
    const plaidBal = balancesFor
      ? await balancesFor(acct.plaid_access_token)
      : await plaidCall(env, "/accounts/balance/get", { access_token: acct.plaid_access_token });
    const bankAcct = (plaidBal.accounts || []).find(
      (x: any) => x.account_id === acct.plaid_account_id
    );
    if (bankAcct) {
      const currentBal = Number(bankAcct.balances?.current);
      if (Number.isFinite(currentBal)) bankPostedBalance = roundMoney(isCreditCardAccount(acct) ? -currentBal : currentBal);
      const availableBal = Number(bankAcct.balances?.available);
      // The bank's available balance already has every pending debit taken out. If it
      // is lower than posted balance minus the pending debits the feed lists, the bank
      // is holding money for something the feed doesn't itemize (so the worker can't
      // import it). Noted so it's never invisible.
      if (!isCreditCardAccount(acct) && Number.isFinite(currentBal) && Number.isFinite(availableBal)) {
        const listedDebits = plaidPending.filter(t => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0);
        const gap = roundMoney(currentBal - listedDebits - availableBal);
        if (gap > 0.5) unlistedHold = gap;
      }

      if (!workerSyncs) {
        if (Number.isFinite(currentBal)) {
          bankBalance = roundMoney(isCreditCardAccount(acct) ? -currentBal : currentBal);
          balanceSource = "Bank posted balance vs YNAB cleared balance (worker sync is off, so pending isn't expected in YNAB)";
        }
      } else if (isCreditCardAccount(acct)) {
        const pendingSigned = roundMoney(
          plaidPending.reduce((sum, t) => sum + Number(t.amount || 0), 0)
        );
        if (Number.isFinite(currentBal)) {
          bankBalance = roundMoney(-(currentBal + pendingSigned));
          balanceSource = "Plaid current + pending (credit-card debt)";
        }
      } else if (Number.isFinite(currentBal)) {
        // Built the same way YNAB's balance is: posted balance, then every pending
        // item in both directions. "available" only subtracts pending DEBITS, so it
        // disagreed with YNAB whenever an inbound Zelle/deposit was pending.
        const pendingSigned = roundMoney(plaidPending.reduce((sum, t) => sum + Number(t.amount || 0), 0));
        // Money the bank has already taken out for something its feed doesn't list yet
        // (a payment you just sent) is real: it counts here, so YNAB shows as off by
        // that much until the feed lists it or you enter it yourself.
        bankBalance = roundMoney(currentBal - pendingSigned - unlistedHold);
        balanceSource = unlistedHold > 0
          ? "Plaid posted balance adjusted for pending, less money the bank is holding that its feed doesn't list yet"
          : "Plaid posted balance adjusted for pending (both directions)";
      } else if (Number.isFinite(availableBal)) {
        bankBalance = roundMoney(availableBal);
        balanceSource = "Plaid available (posted balance unavailable)";
      }

      // Compute parity only after we have a concrete bank balance. This is the
      // primary account-health signal; pending coverage is intentionally separate.
      if (bankBalance != null && ynabBalance != null) {
        balanceDifference = roundMoney(ynabBalance - bankBalance);
        balanceMatch = Math.abs(balanceDifference) <= 0.01;
      }
    }
  } catch {
    // Keep transaction audit alive if the separate balance lookup is unavailable.
  }

  // Reconciliation candidates are deliberately separate from transaction matching.
  // A transaction that merely has the same amount/date as a manual YNAB entry is NOT
  // treated as definitively represented: the payee can be completely different. We
  // only use normal content matching as a confirmed representation signal.
  const representedPlaidIds = new Set<string>(rowByTx.keys());
  if (!workerSyncs) for (const t of raw) if (t.pending) representedPlaidIds.add(t.transaction_id); // not expected in YNAB

  // Card payments in flight. A pending payment on checking is deliberately not
  // imported (it is booked as a transfer once it posts), and the card's "Payment
  // Thank You" is represented by that transfer, which doesn't exist yet while the
  // checking side is pending. For a few days that gap is expected, not a problem.
  // Past IN_TRANSIT_DAYS it counts again, so a payment that never gets its transfer
  // still raises the alarm.
  const IN_TRANSIT_DAYS = 5;
  // Only for accounts the worker syncs: on a Direct Import account the card's payment
  // row can be an ordinary inflow, and it is in the cleared balance already.
  const inTransit = !workerSyncs ? [] : raw.filter(t => {
    if (representedPlaidIds.has(t.transaction_id)) return false;
    const kind = specByTx.get(t.transaction_id)?.skipKind;
    if (!isHeldTransferKind(kind) && !isInSideKind(kind)) return false;
    return daysApart(t.date, todayStr) <= IN_TRANSIT_DAYS;
  });
  for (const t of inTransit) representedPlaidIds.add(t.transaction_id);
  // Each missing bank item contributes its Plaid amount to (YNAB - bank).
  const inTransitDifference = roundMoney(inTransit.reduce((sum, t) => sum + Number(t.amount || 0), 0));

  // Sync off (Direct Import): a posted bank item that matches a row you entered
  // ahead of time (a front-loaded paycheck) is in the bank's posted balance but not
  // yet in YNAB's cleared balance until Direct Import clears your row. That gap is
  // expected, not a problem.
  const awaitingClear = workerSyncs ? [] : raw.filter(t => !t.pending && rowByTx.get(t.transaction_id)?.cleared === "uncleared");
  if (!workerSyncs) {
    // Also a posted bank item that the matcher couldn't tie to a row by name (a card
    // payment booked as a plain "Payment" row, say) but that has exactly one
    // uncleared YNAB row at the same amount within a week, and vice versa. The money
    // is in YNAB; it just isn't cleared yet.
    const usedRows = new Set([...rowByTx.values()].map(r => r.id));
    const loose = raw.filter(t => !t.pending && !rowByTx.has(t.transaction_id));
    for (const t of loose) {
      const milli = Math.round(-t.amount * 1000);
      // Names that contradict each other (SPOTIFY vs your Netflix row) are two
      // different charges, not one waiting to clear.
      const near = (r: YNABExistingTransaction) => r.cleared === "uncleared" && !usedRows.has(r.id) && Number(r.amount || 0) === milli && daysApart(r.date, t.date) <= CARD_PAYMENT_POSTING_DAYS &&
        (!!r.transfer_transaction_id || !namesConflict(plaidPayeeText(t), normalizeMerchant(r.payee_name || ""), routing.aliases));
      const cands = existing.filter(near);
      if (cands.length !== 1) continue;
      if (loose.filter(o => o !== t && Math.round(-o.amount * 1000) === milli && daysApart(cands[0].date, o.date) <= CARD_PAYMENT_POSTING_DAYS).length) continue;
      usedRows.add(cands[0].id);
      awaitingClear.push(t);
      representedPlaidIds.add(t.transaction_id);
    }
  }
  const awaitingClearDifference = roundMoney(awaitingClear.reduce((sum, t) => sum + Number(t.amount || 0), 0));
  const representedRowIds = new Set<string>([...rowByTx.values()].map(r => r.id));
  // Money on its way IN from one of your own accounts: a card payment or transfer the
  // worker booked as soon as the sending bank showed it pending. YNAB already has this
  // side (uncleared); this bank shows it a day or more later. Expected for a few days.
  // On Direct Import the comparison is YNAB's cleared balance, so only legs already
  // counted in it (cleared or reconciled) are part of the difference.
  // A cleared leg the worker once tied to a card-side payment (the card showed the
  // "thank you", then took it back) is NOT on its way: the card reversed it, and that
  // must stay visible. Only a payment the card has never shown counts.
  const cardTied = new Set<string>(Object.values(await readJson(env, `${LINKS_KV_PREFIX}${acct.plaid_account_id}`, {})).map(String));
  const onTheWay = incomingInTransit(acct, existing, representedRowIds, routing, todayStr)
    .filter(r => (workerSyncs || r.cleared !== "uncleared") && !(r.cleared !== "uncleared" && cardTied.has(r.id)));
  for (const r of onTheWay) representedRowIds.add(r.id);
  const onTheWayDifference = roundMoney(onTheWay.reduce((s, r) => s + Number(r.amount || 0) / 1000, 0));

  // Expected differences: income entered ahead of the bank (front-loaded paychecks)
  // that a skip rule says the worker should ignore. These YNAB rows have no bank
  // counterpart yet by design, so they are reported, not alarmed on.
  const expectedRows = existing.filter(e => {
    if (representedRowIds.has(e.id) || e.cleared === "reconciled") return false;
    // Sync off: the comparison uses YNAB's CLEARED balance, so an uncleared
    // front-loaded row is not in it and must not be subtracted as "expected".
    if (!workerSyncs && e.cleared === "uncleared") return false;
    if (daysApart(e.date, todayStr) > 5) return false;
    return coveredBySkipRule(e, acct, skipRules, routing.aliases);
  });
  const frontLoadedDifference = roundMoney(expectedRows.reduce((sum, e) => sum + Number(e.amount || 0) / 1000, 0));
  const expectedDifference = roundMoney(frontLoadedDifference + inTransitDifference + awaitingClearDifference + onTheWayDifference);
  const unexplainedDifference = balanceDifference != null ? roundMoney(balanceDifference - expectedDifference) : null;
  if (unexplainedDifference != null) balanceMatch = Math.abs(unexplainedDifference) <= 0.01;

  // Pairs that match but disagree on the amount: a posted charge whose YNAB row still
  // has another amount (a pending row you reconciled before the tip or final amount
  // posted). Each contributes (YNAB - bank) to the difference.
  const amountMismatch = amountMismatches(raw, rowByTx);
  const amountMismatchTotal = roundMoney(amountMismatch.reduce((s, m) => s + m.difference, 0));

  if (bankBalance != null && ynabBalance != null && !balanceMatch && amountMismatch.length && Math.abs(amountMismatchTotal - (unexplainedDifference as number)) <= 0.01) {
    for (const m of amountMismatch) missingBalanceTransactions.push({ source: "amount", transaction_id: m.transaction_id, date: m.date, payee: m.payee, amount: m.difference, pending: false, confidence: "exact_delta", ynab_amount: m.ynab_amount, bank_amount: m.bank_amount } as any);
  } else if (bankBalance != null && ynabBalance != null && !balanceMatch) {
    const targetDelta = unexplainedDifference as number;

    // Each bank transaction contributes -signedBankAmount to (YNAB - bank).
    // A missing $79.20 charge therefore explains +$79.20 of positive delta; a
    // missing $950 deposit explains -$950. We first look for an exact single
    // transaction, then a two-transaction combination, then retain only the
    // closest plausible candidates rather than dumping every unmatched row.
    const bankCandidates = raw
      .filter(t => !representedPlaidIds.has(t.transaction_id))
      .map(t => ({
        t,
        // Plaid amount is positive for an outflow and negative for an inflow.
        // That is exactly the contribution a bank-only transaction makes to
        // (YNAB balance - bank balance): a missing $79.20 outflow explains +$79.20,
        // while a missing $950 inflow explains -$950.
        contribution: roundMoney(Number(t.amount || 0)),
        distance: Math.abs(roundMoney(Number(t.amount || 0)) - targetDelta)
      }))
      .filter(x => Number.isFinite(x.contribution));

    const tolerance = 0.01;
    const exact = bankCandidates
      .filter(x => Math.abs(x.contribution - targetDelta) <= tolerance)
      .sort((a, b) => Math.abs(a.contribution - targetDelta) - Math.abs(b.contribution - targetDelta));

    if (exact.length > 0) {
      const x = exact[0];
      missingBalanceTransactions.push({
        source: "bank",
        transaction_id: x.t.transaction_id,
        date: x.t.date,
        payee: safePayee(x.t),
        amount: roundMoney(-Number(x.t.amount || 0)),
        pending: !!x.t.pending,
        confidence: existing.some(e =>
          roundMoney(Number(e.amount || 0) / 1000) === roundMoney(-Number(x.t.amount || 0)) &&
          daysApart(e.date, x.t.date) === 0)
          ? "possible" : "exact_delta"
      });
    } else {
      let bestPair: { a: typeof bankCandidates[number]; b: typeof bankCandidates[number]; error: number } | null = null;
      for (let i = 0; i < bankCandidates.length; i++) {
        for (let j = i + 1; j < bankCandidates.length; j++) {
          const a = bankCandidates[i], b = bankCandidates[j];
          const error = Math.abs(a.contribution + b.contribution - targetDelta);
          if (!bestPair || error < bestPair.error) bestPair = { a, b, error };
        }
      }

      if (bestPair && bestPair.error <= 0.01) {
        for (const x of [bestPair.a, bestPair.b]) {
          missingBalanceTransactions.push({
            source: "bank",
            transaction_id: x.t.transaction_id,
            date: x.t.date,
            payee: safePayee(x.t),
            amount: roundMoney(-Number(x.t.amount || 0)),
            pending: !!x.t.pending,
            confidence: "delta_combination"
          });
        }
      } else {
        // No exact explanation. Show only the closest few bank-side candidates and
        // label them as possible, rather than claiming they cause the difference.
        bankCandidates
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 5)
          .forEach(x => missingBalanceTransactions.push({
            source: "bank",
            transaction_id: x.t.transaction_id,
            date: x.t.date,
            payee: safePayee(x.t),
            amount: roundMoney(-Number(x.t.amount || 0)),
            pending: !!x.t.pending,
            confidence: "possible"
          }));
      }
    }

    // Also look for the inverse problem: YNAB contains a transaction that is not
    // represented in Plaid. This is how we explain an opposite-direction mismatch.
    const plaidRepresentedAmounts = raw.map(t => ({ id: t.transaction_id, date: t.date, amount: roundMoney(-Number(t.amount || 0)) }));
    const ynabOnlyCandidates = existing
      .filter(e => workerSyncs ? (e.cleared === "uncleared" || e.cleared === "cleared" || e.cleared === "reconciled") : e.cleared !== "uncleared")
      .filter(e => !plaidRepresentedAmounts.some(p => Math.abs(p.amount - roundMoney(Number(e.amount || 0) / 1000)) <= 0.01 && daysApart(p.date, e.date) <= 1))
      .map(e => ({
        e,
        // YNAB amounts already use YNAB's signed convention. An extra YNAB
        // outflow therefore makes (YNAB - bank) more negative; an extra inflow
        // makes it more positive.
        contribution: roundMoney(Number(e.amount || 0) / 1000),
        distance: Math.abs(roundMoney(Number(e.amount || 0) / 1000) - targetDelta)
      }))
      .filter(x => Number.isFinite(x.contribution))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    for (const x of ynabOnlyCandidates) {
      if (Math.abs(x.contribution - targetDelta) <= 0.01) {
        missingBalanceTransactions.push({
          source: "ynab",
          transaction_id: x.e.id,
          date: x.e.date,
          payee: x.e.payee_name || "YNAB transaction",
          amount: roundMoney(Number(x.e.amount || 0) / 1000),
          pending: x.e.cleared === "uncleared",
          confidence: "exact_delta"
        });
      }
    }
  }

  // Pending coverage remains a secondary diagnostic, separate from balance parity.
  const workerPending = ynabUncleared.filter(isWorkerPendingRow);
  const staleCandidates = workerPending.filter(t => isStalePendingCandidate(t, plaidPendingImportIds, staleDays, todayStr));
  // For checking accounts, YNAB's account-level uncleared_balance is NOT the
  // pending-purchase population we are reconciling. It can include transfers,
  // inflows, and other uncleared rows. Match each bank-pending purchase to an
  // actual YNAB uncleared transaction instead. This is the meaningful signal for
  // the two-feed checking model: every pending bank charge should already be
  // represented in YNAB because Chase has already reduced available balance.
  const matchedPendingYnabIds = new Set<string>();
  const unmatchedPending: PlaidTransaction[] = [];
  let ynabPendingRepresentedTotal = 0;

  // "Is this bank charge represented in YNAB?" is answered by representPlaid, the
  // same matching the sync uses (including the hand-entered exact amount + exact date
  // rule), so the coverage number can never disagree with what the sync does.
  for (const t of plaidPendingPurchases) {
    const match = rowByTx.get(t.transaction_id) || null;
    if (match && !matchedPendingYnabIds.has(match.id)) {
      matchedPendingYnabIds.add(match.id);
      ynabPendingRepresentedTotal = roundMoney(ynabPendingRepresentedTotal + (-t.amount));
    } else {
      unmatchedPending.push(t);
    }
  }
  const pendingVariance = roundMoney(plaidPendingTotal - ynabPendingRepresentedTotal);
  const difference = balanceDifference ?? pendingVariance;
  const unmatchedPendingIds = unmatchedPending.map(t => t.transaction_id);
  const pendingPurchaseCountCovered = plaidPendingPurchases.length - unmatchedPending.length;

  // Pending accuracy is amount-weighted coverage, paired with transaction-count
  // coverage so a few small missing charges are not hidden by one large match.
  const bankPendingMag = Math.abs(plaidPendingTotal);
  const pendingAccuracyPct = bankPendingMag < 0.01
    ? 100
    : Math.max(0, Math.min(100, roundMoney((Math.abs(ynabPendingRepresentedTotal) / bankPendingMag) * 100)));

  const warnings: string[] = [];
  if (bankBalance == null || ynabBalance == null) {
    warnings.push(`Balance check skipped: ${bankBalance == null ? "the bank balance" : "the YNAB balance"} could not be read this run.`);
  }
  const byTx = missingBalanceTransactions.some(t => t.confidence === "exact_delta" || t.confidence === "delta_combination");
  const lagText = unexplainedDifference != null && !balanceMatch && !byTx ? bankBalanceLag(unexplainedDifference, raw, todayStr) : null;
  if (unexplainedDifference != null && !balanceMatch && lagText) {
    warnings.push(`YNAB balance differs from the bank by $${Math.abs(unexplainedDifference).toFixed(2)}. ${lagText}`);
  } else if (unexplainedDifference != null && !balanceMatch) {
    const exact = missingBalanceTransactions.filter(t => t.confidence === "exact_delta");
    const pair = missingBalanceTransactions.filter(t => t.confidence === "delta_combination");
    const why = exact.length ? ` It matches ${exact.map(t => t.payee + " " + t.amount.toFixed(2)).join(", ")} exactly.`
      : pair.length ? ` Together, ${pair.map(t => t.payee + " " + t.amount.toFixed(2)).join(" and ")} account for it exactly.`
      : " No transaction in the window explains it exactly; see Transaction reconcile.";
    warnings.push(`YNAB balance differs from the bank by $${Math.abs(unexplainedDifference).toFixed(2)}.${why}`);
  } else if (workerSyncs && balanceDifference == null && !isCardAccount && Math.abs(pendingVariance) > 1) {
    warnings.push(`${unmatchedPending.length} bank-pending charge(s) are not matched to YNAB pending transactions, totaling $${Math.abs(pendingVariance).toFixed(2)}.`);
  }
  // Cleared vs posted. The working balance can match the bank while YNAB's cleared
  // balance doesn't: a charge that has posted at the bank is still uncleared in YNAB
  // (usually a row you entered, or a transfer). That's what makes reconciling in YNAB
  // come out wrong, so name the rows.
  let clearedDifference: number | null = null;
  let clearedPendingNote: string | null = null;
  const postedButUncleared: Array<{ date: string; payee: string; amount: number }> = [];
  if (workerSyncs && bankPostedBalance != null && ynabClearedTotal != null) {
    // A payment in transit that has already posted on this side (the card shows the
    // "Payment Thank You" while checking is still pending) is in the bank's posted
    // balance but can't be in YNAB yet; that part is expected, like the balance check.
    const postedInTransit = roundMoney(inTransit.filter(t => !t.pending).reduce((sum, t) => sum + Number(t.amount || 0), 0));
    // A payment on its way from your other account that you already marked cleared is
    // in YNAB's cleared balance before the card posts it; expected, like the balance check.
    const onTheWayCleared = roundMoney(onTheWay.filter(r => r.cleared !== "uncleared").reduce((s, r) => s + Number(r.amount || 0) / 1000, 0));
    clearedDifference = roundMoney(ynabClearedTotal - bankPostedBalance - postedInTransit - onTheWayCleared);
    const clearedPending: Array<{ payee: string; amount: number }> = [];
    for (const t of raw) {
      const r = rowByTx.get(t.transaction_id);
      if (!t.pending && r && r.cleared === "uncleared") postedButUncleared.push({ date: r.date, payee: r.payee_name || safePayee(t), amount: roundMoney(Number(r.amount || 0) / 1000) });
      if (t.pending && r && r.cleared !== "uncleared") clearedPending.push({ payee: r.payee_name || safePayee(t), amount: roundMoney(Number(r.amount || 0) / 1000) });
    }
    // Rows you marked cleared while the bank still has them pending (Chase's app
    // balance counts pending, so reconciling to it does this). The bank's posted
    // balance doesn't include them yet, so that part of the gap is expected, not a
    // problem; only what's left over is.
    const clearedPendingTotal = roundMoney(clearedPending.reduce((s, x) => s + x.amount, 0));
    if (clearedPending.length && Math.abs(clearedPendingTotal) > 0.01) {
      clearedPendingNote = `$${Math.abs(clearedPendingTotal).toFixed(2)} of YNAB's cleared balance is ${clearedPending.length} item(s) you marked cleared that the bank still lists as pending; its posted balance counts them once they post. Expected if you reconcile to the balance in the bank's app, which includes pending.`;
      clearedDifference = roundMoney(clearedDifference - clearedPendingTotal);
    }
    const clearedLag = Math.abs(clearedDifference) > 0.01 && !postedButUncleared.length ? bankBalanceLag(clearedDifference, raw, todayStr) : null;
    if (clearedLag) {
      warnings.push(`YNAB's cleared balance differs from the bank's posted balance by $${Math.abs(clearedDifference).toFixed(2)}. ${clearedLag}`);
    } else if (Math.abs(clearedDifference) > 0.01) {
      warnings.push(`YNAB's cleared balance differs from the bank's posted balance by $${Math.abs(clearedDifference).toFixed(2)}` +
        (postedButUncleared.length ? `: posted at the bank but still uncleared in YNAB: ${postedButUncleared.slice(0, 6).map(x => `${x.payee} ${x.amount.toFixed(2)} (${x.date})`).join(", ")}. The next sync marks the ones that match exactly as cleared.` : ". Reconciling in YNAB will be off until this is found; see Transaction reconcile."));
    }
  }
  if (staleCandidates.length > 0) warnings.push(`${staleCandidates.length} worker pending row(s) the bank no longer shows as pending.`);
  if (positiveCreditBalance) warnings.push(`Credit card appears to have a positive balance. YNAB may treat it like cash until spending brings it negative again.`);

  // Informational, not a warning: note any pending card payment we set aside, so the
  // reconciliation is transparent about what it excluded and why.
  const notes: string[] = [];
  if (clearedPendingNote) notes.push(clearedPendingNote);
  if (expectedRows.length > 0) {
    notes.push(`$${Math.abs(frontLoadedDifference).toFixed(2)} of the difference is expected: ${expectedRows.length} front-loaded item(s) covered by skip rules (${expectedRows.map(e => e.payee_name).join(", ")}) that the bank has not posted yet.`);
  }
  if (awaitingClear.length > 0) {
    notes.push(`$${Math.abs(awaitingClearDifference).toFixed(2)} of the difference is posted at the bank and matches a row you entered (${awaitingClear.map(t => safePayee(t) + " " + roundMoney(-t.amount).toFixed(2)).join(", ")}); it clears when Direct Import brings it in.`);
  }
  if (onTheWay.length > 0) {
    notes.push(`$${Math.abs(onTheWayDifference).toFixed(2)} is on its way from your other account (${onTheWay.map(r => `${r.payee_name || "transfer"} $${(Number(r.amount || 0) / 1000).toFixed(2)} on ${r.date}`).join(", ")}): already in YNAB, not at this bank yet. Expected for up to 5 days.`);
  }
  if (inTransit.length > 0) {
    notes.push(`$${Math.abs(inTransitDifference).toFixed(2)} of the difference is a card payment in transit (${inTransit.map(t => safePayee(t) + " " + roundMoney(-t.amount).toFixed(2)).join(", ")}). It is booked as a transfer once it posts; if it is still missing after ${IN_TRANSIT_DAYS} days it counts as a real difference.`);
  }
  if (unlistedHold > 0) {
    const holdText = `The bank is holding $${unlistedHold.toFixed(2)} for something its data feed doesn't list yet: its available balance is that much lower than posted minus the pending charges it shows. Usually a payment or transfer you just made (enter it in YNAB yourself, or wait for the feed); sometimes a hold on a deposit.`;
    notes.push(holdText);
    // Shown as a warning so the account doesn't look fine while money is missing from YNAB.
    if (balanceDifference != null && Math.abs(balanceDifference) > 0.01) warnings.push(holdText);
  }
  if (rawWindow.truncated) notes.push(`Bank data was truncated at ${raw.length} transactions; this audit may be incomplete.`);
  if (plaidPendingTransfers.length > 0) {
    notes.push(`Pending coverage leaves out ${plaidPendingTransfers.length} pending card payment(s) totaling $${Math.abs(plaidPendingTransferTotal).toFixed(2)}: payments are booked once they post, not while pending.`);
  }

  // Account health is driven by bank-vs-YNAB balance parity plus stale worker rows.
  // Pending coverage remains a secondary diagnostic and should not make an otherwise
  // correct account look broken by itself.
  // A difference fully accounted for by named transactions (one exact match, or a
  // pair) is a known state: a warning with the explanation, not an alarm. Only a
  // difference nobody can account for is "needs attention".
  // A gap equal to what just posted (the bank's balance hasn't counted it yet) is
  // explained too: a known, temporary state, not an alarm.
  const differenceExplained = byTx || !!lagText;
  // Once named transactions account for the difference exactly, it is explained, not
  // "unexplained": it is reported as explained_difference and unexplained drops to 0,
  // so the headline number and the explanation never contradict each other.
  const explainedDifference = differenceExplained && unexplainedDifference != null ? unexplainedDifference : 0;
  const remainingUnexplained = differenceExplained ? 0 : unexplainedDifference;
  const balanceOff = remainingUnexplained != null && Math.abs(remainingUnexplained) > 25;
  const status: "healthy" | "warning" | "needs_attention" =
    staleCandidates.length > 0 || balanceOff
      ? "needs_attention"
      : warnings.length > 0
        ? "warning"
        : "healthy";
  // What actually needs attention, in words, for the dashboard headline. (Without
  // this the headline showed the first warning even when the real reason was a
  // stale pending row.)
  const attentionReasons: string[] = [];
  if (balanceOff) attentionReasons.push(`YNAB balance differs from the bank by $${Math.abs(remainingUnexplained as number).toFixed(2)} and nothing in the window explains it.`);
  if (staleCandidates.length > 0) attentionReasons.push(`${staleCandidates.length} worker pending row(s) the bank no longer shows as pending (${staleCandidates.slice(0, 3).map(t => `${t.payee_name || "?"} ${roundMoney(Number(t.amount || 0) / 1000).toFixed(2)} on ${t.date}`).join(", ")}). The sync removes these on its own once it can read the full 30 days of bank data; if they stay, check them in Transaction reconcile.`);

  return {
    account: acct.nickname,
    ynab_account_id: acct.ynab_account_id,
    plaid_account_id: acct.plaid_account_id,
    raw_days: days,
    stale_days: staleDays,
    ynab_uncleared_count: ynabUncleared.length,
    ynab_uncleared_total: ynabUnclearedTotal,
    plaid_pending_count: plaidPendingPurchases.length,
    plaid_pending_total: plaidPendingTotal,
    plaid_pending_transfer_total: plaidPendingTransferTotal,
    plaid_pending_transfer_count: plaidPendingTransfers.length,
    plaid_pending_total_all: plaidPendingTotalAll,
    difference,
    bank_balance: bankBalance,
    ynab_balance: ynabBalance,
    balance_difference: balanceDifference,
    expected_difference: expectedDifference,
    unexplained_difference: remainingUnexplained,
    cleared_difference: clearedDifference,
    amount_mismatch: amountMismatch.slice(0, 20),
    unlisted_pending_hold: unlistedHold || null,
    posted_but_uncleared: postedButUncleared.slice(0, 20),
    explained_difference: explainedDifference,
    // Plain words for the row: which transaction(s) make up the explained difference
    // and which side they're missing from.
    explained_by: lagText ? lagText : differenceExplained
      ? missingBalanceTransactions.filter(t => t.confidence === "exact_delta" || t.confidence === "delta_combination")
          .map((t: any) => t.source === "amount" ? `${t.payee} (${t.date}) is $${Math.abs(t.ynab_amount).toFixed(2)} in YNAB but the bank posted $${Math.abs(t.bank_amount).toFixed(2)}` : `${t.payee} $${Math.abs(t.amount).toFixed(2)} ${t.source === "bank" ? (workerSyncs ? "is at the bank but not in YNAB" : "is posted at the bank but not in YNAB's cleared balance") : "is in YNAB but not at the bank"}`).join("; ")
      : null,
    attention_reasons: attentionReasons,
    balance_match: balanceMatch,
    balance_source: balanceSource,
    worker_syncs: workerSyncs,
    missing_balance_transactions: missingBalanceTransactions.slice(0, 50),
    pending_accuracy_pct: pendingAccuracyPct,
    pending_variance: pendingVariance,
    pending_purchase_count_covered: pendingPurchaseCountCovered,
    pending_purchase_count_total: plaidPendingPurchases.length,
    plaid_pending_unmatched_count: unmatchedPending.length,
    plaid_pending_unmatched_ids: unmatchedPendingIds,
    ynab_pending_represented_total: ynabPendingRepresentedTotal,
    worker_pending_count: workerPending.length,
    stale_pending_count: staleCandidates.length,
    ynab_cleared_total: ynabClearedTotal,
    positive_credit_balance: positiveCreditBalance,
    stale_pending_candidates: staleCandidates.slice(0, 50).map(t => summarizeYnabExisting(t)),
    warnings,
    notes,
    status
  };
}
