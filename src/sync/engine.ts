import { TransferLabel, getTransferLabels } from "../rules/transfer-labels";
import { BOOTSTRAP_OVERLAP_DAYS, CC_TRANSFER_CUTOFF_DEFAULT, IDENTITY_HORIZON_DAYS, IMPORT_WINDOW_DAYS, MAX_MINT_ATTEMPTS, SNAPSHOT_MARGIN_DAYS, STALE_PENDING_DAYS } from "../constants";
import { readJson } from "../health/status";
import { isSyncEnabled } from "../lock/lock";
import { plaidCall } from "../plaid/client";
import { getRecentRawTransactionsDetailed, lookbackDate, toIsoDate } from "../plaid/fetch";
import { PayeeAlias, getPayeeAliases } from "../rules/payee-aliases";
import { getSkipRules, matchingSkipRule } from "../rules/skip-rules";
import { getAccountAutomationSettings, getAccounts, isCreditCardAccount, settingForAccount } from "../store/accounts";
import { logEvent } from "../store/event-log";
import { ALREADY_IN_YNAB_DATE_DAYS, CARD_PAYMENT_POSTING_DAYS, WORKER_PENDING_PREFIX, cleanName, daysApart, getCcEpoch, leadingWordMatch, namesConflict, namesSimilar, nextOccurrence, normalizeMerchant, plaidPayeeText, prunePostedMap, seedOccurrenceCounts, shortStableHash, ynabImportId } from "./matching";
import { accountRefsIn, classifyTransfer, resolveCardForPayment, transferPayeeName, untrackedCardPayee } from "./transfers";
import { appendUndo, getUndoLog } from "./undo";
import { AccountAutomationSetting, AccountConfig, Env, PlaidTransaction, SkipRule, SkippedIncomeRecord, SyncOptions, YNABExistingTransaction, YNABTransaction, normalizePlaidTxn } from "../types";
import { calendarDaysBetween, todayInTimeZone } from "../util/dates";
import { friendlyErrorMessage, plainYnabError, safePayee } from "../util/errors";
import { ynabDeleteTransaction, ynabGetAccountTransactions, ynabGetAccounts, ynabGetTransaction, ynabUpdateEach, ynabUpsert } from "../ynab/client";

// ================= SYNC ENGINE (identity-first, shared by checking and cards) =================
//
// One engine for every account. It replaces the old checking engine (pendingMap,
// postedSignals, linked flip, name-independent twin flip, retirement pass, orphan
// sweep, final dedupe) and the old single-feed card engine, which never wrote any
// charges because its create/update loop was missing.
//
// Identity. Every Plaid charge has ONE lifecycle key for its whole life:
//   pending charge -> its transaction_id
//   posted charge  -> pending_transaction_id when Plaid links it, else transaction_id
// A YNAB row is "owned" by a lifecycle key when:
//   - its import_id is the id the worker derives for that key (wpend:/pcc:/pcp:),
//   - its import_id is the posted id pinned in postedMap for that charge, or
//   - the key is recorded in the links map (KV "links:<plaid account>").
// Once a row is owned by one charge, no other charge can claim it. That is what
// stops a second identical coffee from hiding behind the first.
//
// Phases per run (no writes until the plan is complete):
//   P1 ownership        charge -> the row it already owns
//   P2 posted flip      posted charge with no link -> an orphaned worker pending row
//                       (Plaid renamed it, or nulled pending_transaction_id)
//   P3 content match    charge -> an unowned manual / Direct Import row (then linked)
//   P4 duplicate race   worker row + an unowned non-worker row for the same charge
//                       (manual entry, or Direct Import posted first) -> keep theirs
//   P5 updates          flip pending -> posted in place, adopt amount/date changes
//   P6 creates          anything still unrepresented
//   P7 retirement       worker pending rows the bank no longer shows as pending
// Writes run creates -> updates -> deletes, so a failure never leaves a charge with
// zero rows. Content matching is only a fallback, and it is one-to-one.

// How far back to look when deciding whether a worker pending row is still pending at
// the bank. Longer than the import window because holds (hotels, gas, rentals) can
// stay pending 7-10 days.
// 30 days also lets rows left pending by older versions flip to posted instead of
// being dropped. One /transactions/get call covers it (page size 500).
export const VERIFY_WINDOW_DAYS = 30;
export const LINKS_KV_PREFIX = "links:";
export const CARD_POSTED_PREFIX = "pcp:";

// A card payment only ever moves money one way: OUT of checking (positive Plaid
// amount) and INTO the card (negative Plaid amount on the card). The classifier's
// name fallback ("PAYMENT" + "CARD") can match an ordinary merchant descriptor such
// as a Nintendo purchase, so direction is required before treating anything as a
// payment. A charge on a card is never a card payment.
// On the card itself, money in that the card words as a payment ("MOBILE PAYMENT -
// THANK YOU", "AUTOPAY PAYMENT - THANK YOU", "PAYMENT RECEIVED") is a payment
// whatever category Plaid gave it; Plaid has labeled Amex thank-yous GENERAL_SERVICES
// and INCOME.
export const CARD_SIDE_PAYMENT_RE = /\bPAYMENT\b.*\bTHANK YOU\b|\bTHANK YOU\b.*\bPAYMENT\b|\bAUTO ?PAY(MENT)?\b|\bPAYMENT RECEIVED\b|\bAUTOMATIC PAYMENT\b|\b(MOBILE|ONLINE|INTERNET|ELECTRONIC) PAYMENT\b/;
export function isCardPaymentFor(acct: AccountConfig, t: PlaidTransaction): boolean {
  if (isCreditCardAccount(acct)) {
    if (t.amount >= 0) return false;
    if (classifyTransfer(t) === "card_payment") return true;
    return CARD_SIDE_PAYMENT_RE.test(((t.name || "") + " " + (t.merchant_name || "")).toUpperCase());
  }
  return classifyTransfer(t) === "card_payment" && t.amount > 0;
}

export function lifecycleKey(t: PlaidTransaction): string {
  return t.pending ? t.transaction_id : (t.pending_transaction_id || t.transaction_id);
}

export interface DesiredRow {
  account_id: string;
  date: string;
  amount: number;            // milliunits, negative = outflow
  payee_name: string;
  payee_id?: string | null;  // set for checking -> tracked card transfers
  cleared: "cleared" | "uncleared";
  memo?: string;
}

export type SkipKind = "rule" | "card_side" | "cutoff" | "pending_card_payment" | "pending_transfer";

// The card side of a card payment: represented by the leg of the transfer booked from
// the paying account, not imported on its own.
export function isInSideKind(k?: SkipKind): boolean { return k === "card_side"; }
// A pending payment or transfer that is booked (as a transfer) once it posts.
export function isHeldTransferKind(k?: SkipKind): boolean { return k === "pending_card_payment" || k === "pending_transfer"; }

export interface DesiredSpec {
  skip?: string;
  skipKind?: SkipKind;
  row?: DesiredRow;
  // Money arriving from another of your accounts (named in the bank text): the YNAB
  // account it came from. If that transfer is already booked, its leg is this row.
  transferFrom?: string;
}

export interface RoutingContext {
  accounts: AccountConfig[];
  settings: AccountAutomationSetting[];
  cardPayeeByNickname: Record<string, string>;
  // YNAB transfer payee for every mapped account (checking included), and each
  // account's last 4 from Plaid, so transfers between your own accounts can be booked.
  accountPayeeByNickname: Record<string, string>;
  masks: Record<string, string>;   // plaid_account_id -> last 4
  // Accounts (checked or synced, not cards) whose last 4 isn't known yet: a transfer
  // to one of them can't be recognized until it is.
  masksMissing: string[];
  cutoff: string;
  ok: boolean;
  aliases: PayeeAlias[];   // snapshot for this operation
  transferLabels: TransferLabel[];   // your account tails -> payee names (KV "transfer_labels")
}

// Each account's last 4 digits, from Plaid, cached in KV (they don't change). Looked
// up once for accounts that don't have one yet; a failed lookup is retried next run.
export async function getAccountMasks(env: Env, accounts: AccountConfig[], persist = true): Promise<Record<string, string>> {
  const masks: Record<string, string> = await readJson(env, "plaid_masks", {});
  // Only accounts the worker syncs or checks; an account that's fully off gets no calls.
  const settings = await getAccountAutomationSettings(env);
  const missing = accounts.filter(a => {
    const st = settingForAccount(settings, a);
    return !masks[a.plaid_account_id] && a.plaid_access_token && (st.sync_enabled || st.audit_enabled);
  });
  if (missing.length === 0) return masks;
  let changed = false;
  for (const token of [...new Set(missing.map(a => a.plaid_access_token))]) {
    try {
      const r = await plaidCall(env, "/accounts/get", { access_token: token });
      for (const x of (r.accounts || [])) if (x.account_id && x.mask && !masks[x.account_id]) { masks[x.account_id] = String(x.mask); changed = true; }
    } catch { /* try again next run */ }
  }
  if (changed && persist) await env.SYNC_STATE.put("plaid_masks", JSON.stringify(masks));
  return masks;
}

// Does this look like money moving between accounts at all (as opposed to a purchase
// at store #1274 or a refund with a reference number)?
export function isTransferLooking(t: PlaidTransaction): boolean {
  const kind = classifyTransfer(t);
  if (kind === "outflow_track" || kind === "spendable_in") return true;
  if ((t.pfc_primary || "").toUpperCase().startsWith("TRANSFER")) return true;
  return /\b(TRANSFER|XFER|ACH|ZELLE|P2P)\b/.test(((t.name || "") + " " + (t.merchant_name || "")).toUpperCase());
}

export const GENERIC_BANK_WORDS = new Set(["bank", "na", "n.a.", "financial", "credit", "union", "of", "the", "and", "national", "association", "fsb", "co"]);
export function institutionWords(a: AccountConfig): string[] {
  return String(a.institution || "").toLowerCase().split(/[^a-z0-9.]+/).filter(w => w.length >= 3 && !GENERIC_BANK_WORDS.has(w));
}

// A transfer between two of your own (non-card) accounts: the other account the bank
// text names. It has to look like a transfer, and the other account has to be named
// as an ACCOUNT ("...1274", "XXXXXX1083", "ACCT 1274", or words you saved), not just
// contain the digits (a store number, a phone number, a trace number). Money coming IN
// may also be named by the other bank's name ("ACH DEPOSIT JPMORGAN CHASE"); that only
// lets it be matched to a transfer already booked, so the looser rule is safe there.
// Only a single unambiguous match counts.
export function resolveAccountTransfer(t: PlaidTransaction, source: AccountConfig, ctx: RoutingContext, byInstitution = false): AccountConfig | null {
  if (!isTransferLooking(t)) return null;
  const text = ((t.name || "") + " " + (t.merchant_name || "")).toLowerCase();
  const refs = new Set(accountRefsIn(t));
  const others = ctx.accounts.filter(a => a.nickname !== source.nickname && !isCreditCardAccount(a));
  const hits = others.filter(a => {
    const last4 = [...(a.payment_match?.last4 || []), ctx.masks[a.plaid_account_id] || ""].filter(Boolean);
    const words = a.payment_match?.words || [];
    return last4.some(l => refs.has(l)) || words.some(w => w && text.includes(w.toLowerCase()));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 || !byInstitution) return null;
  const byName = others.filter(a => institutionWords(a).some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.]/g, "\\.")}([^a-z0-9]|$)`).test(text)));
  return byName.length === 1 ? byName[0] : null;
}

export async function loadRoutingContext(env: Env, readOnly = false): Promise<RoutingContext> {
  const ctx: RoutingContext = { accounts: [], settings: [], cardPayeeByNickname: {}, accountPayeeByNickname: {}, masks: {}, masksMissing: [], cutoff: CC_TRANSFER_CUTOFF_DEFAULT, ok: false, aliases: [], transferLabels: [] };
  ctx.aliases = await getPayeeAliases(env);
  try {
    ctx.accounts = await getAccounts(env);
    ctx.settings = await getAccountAutomationSettings(env);
    if (env.CC_TRANSFER_CUTOFF) ctx.cutoff = env.CC_TRANSFER_CUTOFF;
    const kvCutoff = await env.SYNC_STATE.get("cc_transfer_cutoff");
    if (kvCutoff) ctx.cutoff = kvCutoff;
    ctx.transferLabels = await getTransferLabels(env);
    // Account numbers first: even if YNAB's account list can't be read below, a
    // transfer to your other account is still recognized (and then held, not booked
    // as a plain outflow).
    ctx.masks = await getAccountMasks(env, ctx.accounts, !readOnly);
    const summaries = await ynabGetAccounts(env);
    for (const a of ctx.accounts) {
      const s = summaries.find(x => x.id === a.ynab_account_id);
      if (!s?.transfer_payee_id) continue;
      ctx.accountPayeeByNickname[a.nickname] = s.transfer_payee_id;
      if (isCreditCardAccount(a)) ctx.cardPayeeByNickname[a.nickname] = s.transfer_payee_id;
    }
    ctx.masksMissing = ctx.accounts.filter(a => {
      if (isCreditCardAccount(a) || ctx.masks[a.plaid_account_id] || (a.payment_match?.last4 || []).length) return false;
      const st = settingForAccount(ctx.settings, a);
      return st.sync_enabled || st.audit_enabled;
    }).map(a => a.nickname);
    ctx.ok = true;
  } catch {
    // Without routing context a card payment can't be written as a transfer, so the
    // engine holds any new posted card payment until a run where this works
    // (ctx.ok=false). Everything else syncs normally.
  }
  return ctx;
}

// The single place that decides what YNAB row a Plaid charge should become.
// Skip rules are evaluated FIRST for every charge. (Previously transfers and income
// returned before the rules ran, so a paycheck categorized INCOME or a Zelle
// categorized TRANSFER_IN was imported despite its skip rule.)
export function desiredForPlaid(t: PlaidTransaction, acct: AccountConfig, skipRules: SkipRule[], ctx: RoutingContext): DesiredSpec {
  const kind = classifyTransfer(t);
  const milli = Math.round(-t.amount * 1000);
  const cleared: "cleared" | "uncleared" = t.pending ? "uncleared" : "cleared";
  const base = { account_id: acct.ynab_account_id, date: t.date, amount: milli, cleared };

  if (isCreditCardAccount(acct) && isCardPaymentFor(acct, t)) {
    return { skip: "card-side payment; represented by the checking -> card transfer", skipKind: "card_side" };
  }

  const rule = matchingSkipRule(t, acct, skipRules);
  if (rule) return { skip: rule.reason, skipKind: "rule" };

  if (!isCreditCardAccount(acct) && kind === "card_payment" && t.amount > 0) {
    // Forward-only: payments before the cutoff are already in the card's balance.
    if (t.date < ctx.cutoff) return { skip: `card payment before cutoff ${ctx.cutoff}`, skipKind: "cutoff" };
    const target = resolveCardForPayment(t, ctx.accounts, ctx.settings);
    const payeeId = target ? (ctx.cardPayeeByNickname[target.nickname] || null) : null;
    // A pending payment to a tracked card is booked right away as an uncleared
    // transfer, so checking's balance drops the moment the bank takes the money (the
    // bank's available balance already has). It is marked cleared when it posts.
    // Only if the card's YNAB transfer payee can't be read this run is it held back,
    // so it is never booked as a plain outflow by mistake.
    if (t.pending && target && payeeId) return { row: { ...base, payee_name: "", payee_id: payeeId, cleared: "uncleared", memo: "Pending" } };
    if (t.pending && target) return { skip: "card payment pending; booked once the card's transfer payee can be read", skipKind: "pending_card_payment" };
    if (t.pending) return { row: { ...base, payee_name: untrackedCardPayee(t), memo: "Pending" } };
    if (payeeId) return { row: { ...base, payee_name: "", payee_id: payeeId, cleared: "cleared" } };
    return { row: { ...base, payee_name: untrackedCardPayee(t), cleared: "cleared" } };
  }

  // Money moving between two of your own accounts (checking at one bank <-> another). It is
  // booked once, as a YNAB transfer, from the side the money leaves. Like card
  // payments, a pending transfer is booked when it posts. The receiving side is an
  // ordinary inflow that remembers where it came from: if the transfer is already in
  // YNAB, its leg is the row (the engine matches it), otherwise the inflow is imported
  // so the money is never missing.
  let transferFrom: string | undefined;
  if (!isCreditCardAccount(acct) && kind !== "card_payment") {
    if (t.amount > 0) {
      const other = resolveAccountTransfer(t, acct, ctx);
      const payeeId = other ? (ctx.accountPayeeByNickname[other.nickname] || null) : null;
      // Booked right away (uncleared while pending), like a card payment.
      if (payeeId) return { row: { ...base, payee_name: "", payee_id: payeeId, cleared: t.pending ? "uncleared" : "cleared", memo: t.pending ? "Pending" : undefined } };
      // The other account is yours, but its YNAB transfer payee couldn't be read this
      // run: hold it rather than book a plain outflow that is never corrected.
      if (other && !ctx.ok) return { skip: "transfer to your other account; booked once its YNAB transfer payee can be read", skipKind: "pending_transfer" };
    } else if (t.amount < 0) {
      transferFrom = resolveAccountTransfer(t, acct, ctx, true)?.ynab_account_id;
    }
  }

  const payee = (kind === "outflow_track" || kind === "spendable_in")
    ? transferPayeeName(t, kind, ctx.transferLabels)
    : (t.merchant_name || cleanName(t.name));
  const spec: DesiredSpec = { row: { ...base, payee_name: String(payee || "Unknown").slice(0, 100), memo: t.pending ? "Pending" : undefined } };
  if (transferFrom) spec.transferFrom = transferFrom;
  return spec;
}

export function isWorkerImportPrefix(importId: string | null | undefined): boolean {
  const s = String(importId || "");
  return s.startsWith(WORKER_PENDING_PREFIX) || s.startsWith("pl:") || s.startsWith("pcc:") || s.startsWith(CARD_POSTED_PREFIX) || s.startsWith("axfix:");
}

// Any row the worker created from a PENDING charge, whatever its cleared status now.
export function isWorkerPendingOrigin(t: YNABExistingTransaction): boolean {
  const s = String(t.import_id || "");
  return s.startsWith(WORKER_PENDING_PREFIX) || s.startsWith("pl:") || s.startsWith("pcc:");
}

// Uncleared row created by the worker's pending path (checking wpend:/legacy pl:, or
// a card pcc: row). Ownership is decided by import id alone; a memo the user added
// no longer hides a row from its lifecycle.
export function isWorkerPendingRow(t: YNABExistingTransaction): boolean {
  if (t.cleared !== "uncleared") return false;
  const s = String(t.import_id || "");
  return s.startsWith(WORKER_PENDING_PREFIX) || s.startsWith("pl:") || s.startsWith("pcc:");
}

export function expectedPendingImportId(acct: AccountConfig, lifecycle: string, epoch: string): string {
  return isCreditCardAccount(acct)
    ? `pcc:${epoch}:${shortStableHash(lifecycle)}`
    : `${WORKER_PENDING_PREFIX}${shortStableHash(lifecycle)}`;
}

export function cardPostedImportId(lifecycle: string, epoch: string): string {
  return `${CARD_POSTED_PREFIX}${epoch}:${shortStableHash(lifecycle)}`;
}

// Content fallback: which unowned rows could represent this charge? Exact amount,
// date within the window, and either structural transfer identity (for tracked
// card payments) or a similar payee. Returns the closest-dated candidate.
export function contentMatch(
  t: PlaidTransaction,
  spec: DesiredSpec,
  rows: YNABExistingTransaction[],
  isEligible: (r: YNABExistingTransaction) => boolean,
  aliases: PayeeAlias[],
  strength: "strong" | "leading_word" = "strong"
): YNABExistingTransaction | null {
  const milli = Math.round(-t.amount * 1000);
  const want = spec.row;
  const transferPayeeId = want?.payee_id || null;
  const kind = classifyTransfer(t);
  const untrackedCard = kind === "card_payment" && !transferPayeeId;
  const names = [plaidPayeeText(t)];
  if (want?.payee_name) names.push(normalizeMerchant(want.payee_name));

  let best: YNABExistingTransaction | null = null;
  let bestDays = Infinity;
  for (const e of rows) {
    if (!isEligible(e)) continue;
    if (Number(e.amount || 0) !== milli) continue;
    // Money the bank says came from your Chase account is never your transfer from
    // some other account (Savings) that happens to have the same amount.
    if (spec.transferFrom && e.transfer_transaction_id && e.transfer_account_id && e.transfer_account_id !== spec.transferFrom) continue;
    const dd = daysApart(t.date, e.date);
    // A payment sent from another bank (bank A -> a card at bank B) is booked in YNAB the day you
    // send it, but the card can credit it several business days later. The card-side
    // payment is matched structurally (exact amount, a transfer row), so a wider date
    // window is safe for it.
    if (dd > (isInSideKind(spec.skipKind) ? CARD_PAYMENT_POSTING_DAYS : ALREADY_IN_YNAB_DATE_DAYS)) continue;

    let ok = false;
    if (transferPayeeId) {
      // Tracked card payment: must be a real transfer to THAT card. No fallback to
      // "any transfer" when the payee is unknown; transferPayeeId is only set when known.
      ok = !!e.transfer_transaction_id && e.payee_id === transferPayeeId;
    } else if (isInSideKind(spec.skipKind)) {
      // Card-side "Payment Thank You" is represented by the incoming transfer leg.
      ok = !!e.transfer_transaction_id;
    } else {
      const raw = String(e.payee_name || "");
      const upper = raw.toUpperCase();
      const norm = normalizeMerchant(raw);
      ok = strength === "strong"
        ? names.some(n => namesSimilar(n, norm, aliases))
        : names.some(n => leadingWordMatch(n, norm, aliases));
      if (!ok && untrackedCard && strength === "strong") {
        // An established Amex payee ("Payment: Platinum Card - 1234").
        ok = want?.payee_name === "American Express" &&
          (upper.includes("AMERICAN EXPRESS") || upper.includes("AMEX"));
      }
    }
    if (ok && dd < bestDays) { best = e; bestDays = dd; }
  }
  return best;
}

// Last resort, after all name matching: pair a leftover bank charge with a leftover
// YNAB row when the amount is exact, the dates are within the window, and the
// pairing is unambiguous BOTH ways (the only leftover charge at that amount near
// that row, and the only leftover row at that amount near that charge). Catches
// names no rule could match ("2ST PAUL SAINT ST PAUL" vs "2psc"). Ordinary charges
// never pair with transfers; a payment to a card the worker can't identify pairs only
// with a transfer (callers leave out payments to tracked cards, which are matched to
// that card's transfer structurally).
//
// Names that contradict each other normally block the pairing. The one exception is
// a hand-entered row (no import_id) on the SAME date: you typed "Groceries $52.13"
// and the bank says "CUB FOODS #1234". Same amount, same day, and nothing else on
// either side that it could be, so it is the same purchase. The engine, the audit
// and the reconcile view all use this one rule.
export function uniqueAmountPairs<T extends { t: PlaidTransaction; inSide?: boolean }>(
  leftovers: T[],
  rows: YNABExistingTransaction[],
  isEligible: (r: YNABExistingTransaction, item: T) => boolean,
  aliases: PayeeAlias[],
  isDirectImport: (r: YNABExistingTransaction) => boolean = () => false
): Array<[T, YNABExistingTransaction]> {
  const milli = (t: PlaidTransaction) => Math.round(-t.amount * 1000);
  // A card payment (either side) pairs only with a transfer row. Everything else,
  // including a refund or statement credit on a card, pairs only with a non-transfer
  // row, so a $100 refund is never taken for a $100 payment's leg.
  const paymentLike = (item: T) => !!item.inSide || classifyTransfer(item.t) === "card_payment";
  const near = (t: PlaidTransaction, r: YNABExistingTransaction) =>
    Number(r.amount || 0) === milli(t) &&
    daysApart(t.date, r.date) <= (r.transfer_transaction_id ? CARD_PAYMENT_POSTING_DAYS : ALREADY_IN_YNAB_DATE_DAYS);
  const pairs: Array<[T, YNABExistingTransaction]> = [];
  for (const item of leftovers) {
    // A card payment pairs only with a transfer row (a payment to a card the worker
    // can't name from the bank text, e.g. "CHASE CREDIT CRD EPAY" with no last 4, or
    // a payment into a card that you or Direct Import booked as a transfer from
    // another bank, which the card can credit days later). Everything else pairs only
    // with non-transfer rows.
    const isPayment = paymentLike(item);
    const kindOk = (r: YNABExistingTransaction) => isPayment ? !!r.transfer_transaction_id : !r.transfer_transaction_id;
    const cands = rows.filter(r => kindOk(r) && isEligible(r, item) && near(item.t, r));
    if (cands.length !== 1) continue;
    const r = cands[0];
    // Names that clearly contradict each other are never paired on amount alone
    // (a transfer row's name is the account, so it isn't compared).
    const handEnteredSameDay = !r.import_id && r.date === item.t.date;
    // A Direct Import row's id records the bank's own amount and date for the charge
    // ("YNAB:-61470:2026-10-06:1"). When those agree with this charge and it is the
    // only candidate both ways, it IS this charge, whatever you renamed it to in YNAB.
    if (!isPayment && !r.transfer_transaction_id && !handEnteredSameDay && !directImportIdAgrees(r, item.t, isDirectImport) && namesConflict(plaidPayeeText(item.t), normalizeMerchant(r.payee_name || ""), aliases)) continue;
    const rivals = leftovers.filter(o => o !== item && near(o.t, r) && paymentLike(o) === isPayment);
    if (rivals.length > 0) continue;
    pairs.push([item, r]);
  }
  return pairs;
}

// Charges matched to Direct Import rows by the amount and date in the row's import id,
// one to one, nearest date first. Direct Import made each of those rows from one bank
// charge, so several same-amount charges near each other still pair up (which of two
// identical $15.39 charges keeps your renamed row doesn't change any balance), instead
// of every one of them looking new and being booked a second time at a switchover.
export function directImportPairs<T extends { t: PlaidTransaction; inSide?: boolean }>(
  items: T[], rows: YNABExistingTransaction[], isEligible: (r: YNABExistingTransaction, item: T) => boolean,
  isDirectImport: (r: YNABExistingTransaction) => boolean
): Array<[T, YNABExistingTransaction]> {
  const idDate = (r: YNABExistingTransaction) => String(r.import_id || "").split(":")[2] || r.date;
  const edges: Array<{ item: T; r: YNABExistingTransaction; k: number[] }> = [];
  for (const item of items) {
    if (item.inSide || classifyTransfer(item.t) === "card_payment") continue;
    for (const r of rows) {
      if (r.transfer_transaction_id || !isEligible(r, item) || !directImportIdAgrees(r, item.t, isDirectImport)) continue;
      edges.push({ item, r, k: [daysApart(idDate(r), item.t.date), daysApart(r.date, item.t.date)] });
    }
  }
  edges.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || (a.item.t.date < b.item.t.date ? -1 : a.item.t.date > b.item.t.date ? 1 : 0) || (a.r.id < b.r.id ? -1 : 1));
  const usedItems = new Set<T>(), usedRows = new Set<string>();
  const out: Array<[T, YNABExistingTransaction]> = [];
  for (const e of edges) {
    if (usedItems.has(e.item) || usedRows.has(e.r.id)) continue;
    usedItems.add(e.item); usedRows.add(e.r.id); out.push([e.item, e.r]);
  }
  return out;
}

export function directImportIdAgrees(r: YNABExistingTransaction, t: PlaidTransaction, isDirectImport: (r: YNABExistingTransaction) => boolean): boolean {
  if (!isDirectImport(r)) return false;
  const m = /^YNAB:(-?\d+):(\d{4}-\d{2}-\d{2}):\d+$/.exec(String(r.import_id || ""));
  if (!m) return false;
  return Number(m[1]) === Math.round(-t.amount * 1000) && Number(m[1]) === Number(r.amount) && daysApart(m[2], t.date) <= 2;
}

// The leg, in this account, of a transfer booked from another of your accounts that
// represents money arriving here. Exact amount, within CARD_PAYMENT_POSTING_DAYS.
// When the bank text names the sending account, only a leg from THAT account counts
// (closest date wins, for a regular same-amount transfer). When it doesn't, the
// deposit has to look like a transfer, the leg must come from an account the worker
// syncs, and the pairing has to be the only one both ways (rivals: other unmatched
// deposits of the same amount). A transfer you entered from an account the worker
// doesn't know (Savings) is never taken.
export function transferLegFor(
  t: PlaidTransaction, spec: DesiredSpec, acct: AccountConfig, rows: YNABExistingTransaction[],
  isEligible: (r: YNABExistingTransaction) => boolean, ctx: RoutingContext, rivals: PlaidTransaction[]
): YNABExistingTransaction | null {
  if (isCreditCardAccount(acct) || t.amount >= 0) return null;
  const milli = Math.round(-t.amount * 1000);
  const near = (r: YNABExistingTransaction, d: string) => Number(r.amount) === milli && daysApart(r.date, d) <= CARD_PAYMENT_POSTING_DAYS;
  if (spec.transferFrom) {
    let best: YNABExistingTransaction | null = null; let bestDays = Infinity;
    for (const r of rows) {
      if (!r.transfer_transaction_id || r.transfer_account_id !== spec.transferFrom || !near(r, t.date) || !isEligible(r)) continue;
      const d = daysApart(r.date, t.date);
      if (d < bestDays) { best = r; bestDays = d; }
    }
    return best;
  }
  // An unnamed deposit is only taken for a transfer when it reads like one ("ONLINE
  // TRANSFER", "XFER"), is not a paycheck or a payment-app deposit (Zelle, Venmo,
  // PayPal, Cash App), and arrived on or after the day the transfer was sent. A $500
  // paycheck must never become the arrival of a $500 transfer: if that transfer were
  // then cancelled, deleting it would take the paycheck with it.
  const text = ((t.name || "") + " " + (t.merchant_name || "")).toUpperCase();
  if (!/\b(TRANSFER|XFER)\b/.test(text) || /\b(ZELLE|VENMO|PAYPAL|CASH ?APP|PAYROLL|SALARY|DIR DEP|DIRECT DEP)/.test(text) ||
    (t.pfc_primary || "").toUpperCase() === "INCOME") return null;
  const synced = new Set(ctx.accounts.filter(a => a.nickname !== acct.nickname && !isCreditCardAccount(a) && settingForAccount(ctx.settings, a).sync_enabled).map(a => a.ynab_account_id));
  const cands = rows.filter(r => !!r.transfer_transaction_id && synced.has(String(r.transfer_account_id || "")) && near(r, t.date) && r.date <= t.date && isEligible(r));
  if (cands.length !== 1) return null;
  if (rivals.some(o => o.amount === t.amount && isTransferLooking(o) && daysApart(o.date, cands[0].date) <= CARD_PAYMENT_POSTING_DAYS)) return null;
  return cands[0];
}

// Ownership index over a register snapshot. Shared by the engine, the audit and the
// reconcile report, so all three agree on which row belongs to which charge.
export interface Ownership {
  ownerOf: Map<string, string>;        // row id -> identity key
  rowFor(t: PlaidTransaction): YNABExistingTransaction | null;
  isOwnedByOther(row: YNABExistingTransaction, t: PlaidTransaction | null): boolean;
}

export function buildOwnership(
  acct: AccountConfig,
  register: YNABExistingTransaction[],
  links: Record<string, string>,
  postedMap: Record<string, string>,
  legacyPendingMap: Record<string, string>,
  knownCharges: PlaidTransaction[],
  epoch: string,
  removedPendingIds: string[] = []
): Ownership {
  const byId = new Map<string, YNABExistingTransaction>();
  const byImport = new Map<string, YNABExistingTransaction>();
  for (const r of register) {
    byId.set(r.id, r);
    if (r.import_id) byImport.set(r.import_id, r);
  }
  const ownerOf = new Map<string, string>();
  const own = (row: YNABExistingTransaction | undefined, key: string) => {
    if (row && !ownerOf.has(row.id)) ownerOf.set(row.id, key);
  };

  for (const [key, rowId] of Object.entries(links)) own(byId.get(rowId), key);
  for (const [plaidId, importId] of Object.entries(legacyPendingMap)) own(byImport.get(importId), plaidId);
  for (const [txId, importId] of Object.entries(postedMap)) own(byImport.get(importId), "tx:" + txId);
  for (const t of knownCharges) {
    const L = lifecycleKey(t);
    own(byImport.get(expectedPendingImportId(acct, L, epoch)), L);
    if (isCreditCardAccount(acct)) own(byImport.get(cardPostedImportId(L, epoch)), L);
  }
  // A pending charge Plaid removed this run still owns its row by name, so the rules
  // that act on "Plaid removed this charge" (reuse the row, or retire it) can see it.
  for (const k of removedPendingIds) own(byImport.get(expectedPendingImportId(acct, k, epoch)), k);

  const identities = (t: PlaidTransaction) => {
    const L = lifecycleKey(t);
    const ids = new Set<string>([L, "tx:" + t.transaction_id]);
    if (t.pending_transaction_id) ids.add(t.pending_transaction_id);
    return ids;
  };

  return {
    ownerOf,
    rowFor(t) {
      const L = lifecycleKey(t);
      const candidates = [
        links[L] ? byId.get(links[L]) : undefined,
        postedMap[t.transaction_id] ? byImport.get(postedMap[t.transaction_id]) : undefined,
        isCreditCardAccount(acct) ? byImport.get(cardPostedImportId(L, epoch)) : undefined,
        byImport.get(expectedPendingImportId(acct, L, epoch)),
        legacyPendingMap[L] ? byImport.get(legacyPendingMap[L]) : undefined
      ].filter(Boolean) as YNABExistingTransaction[];
      if (candidates.length === 0) return null;
      // Older versions could leave a charge with BOTH a posted row and an orphaned
      // pending row. For a posted charge keep the settled row; the leftover pending
      // row is then unclaimed and retired in P7.
      if (!t.pending) {
        const settled = candidates.find(c => c.cleared !== "uncleared");
        if (settled) return settled;
      }
      return candidates[0];
    },
    isOwnedByOther(row, t) {
      const owner = ownerOf.get(row.id);
      if (!owner) return false;
      if (!t) return true;
      return !identities(t).has(owner);
    }
  };
}

// windowImport: "all" creates rows for anything in the account's import window (the
// backfill safety net); "pending" only pending rows (bootstrap); "none" uses the window
// only to verify what is still pending.
export async function syncAccountEngine(env: Env, acct: AccountConfig, skipRules: SkipRule[], options: SyncOptions = {}): Promise<any> {
  const isCard = isCreditCardAccount(acct);
  const pid = acct.plaid_account_id;
  const cursorKey = `cursor:${pid}`;
  const postedKey = `posted:${pid}`;
  const pendingKey = `pending:${pid}`;
  const linksKey = `${LINKS_KV_PREFIX}${pid}`;
  const events = options.events;

  let cursor = (await env.SYNC_STATE.get(cursorKey)) || "";
  const cursorAtStart = cursor;
  const epoch = isCard ? await getCcEpoch(env, pid) : "";
  const postedMap: Record<string, string> = await readJson(env, postedKey, {});
  const postedJsonAtStart = JSON.stringify(postedMap);
  const legacyPendingMap: Record<string, string> = await readJson(env, pendingKey, {});
  const links: Record<string, string> = await readJson(env, linksKey, {});
  const linksJsonAtStart = JSON.stringify(links);
  // Import ids YNAB refused (it never re-accepts an id it has seen, e.g. a row the
  // user deleted). Remembered so the worker doesn't retry them on every run.
  const rejectedKey = `rejected:${pid}`;
  const rejectedIds: Record<string, string> = await readJson(env, rejectedKey, {});
  const ctx = await loadRoutingContext(env, !!options.dryRun);

  // ---- Plaid: cursor deltas ----
  const added: PlaidTransaction[] = [];
  const modified: PlaidTransaction[] = [];
  const removedIds = new Set<string>();
  if (!options.backfillOnly) {
    const originalCursor = cursor;
    const maxPaginationRestarts = 3;
    let completed = false;
    for (let attempt = 0; attempt <= maxPaginationRestarts && !completed; attempt++) {
      // A mutation-during-pagination invalidates the entire page sequence. Discard
      // every partial result and restart from the cursor supplied to page one.
      added.length = 0;
      modified.length = 0;
      removedIds.clear();
      let pageCursor = originalCursor;
      let hasMore = true;
      try {
        while (hasMore) {
          const resp = await plaidCall(env, "/transactions/sync", { access_token: acct.plaid_access_token, cursor: pageCursor, count: 500 });
          added.push(...resp.added.filter((t: any) => t.account_id === pid).map(normalizePlaidTxn));
          modified.push(...resp.modified.filter((t: any) => t.account_id === pid).map(normalizePlaidTxn));
          for (const r of resp.removed) if (r.account_id === pid) removedIds.add(r.transaction_id);
          pageCursor = resp.next_cursor;
          hasMore = resp.has_more;
        }
        cursor = pageCursor;
        completed = true;
      } catch (error: any) {
        const message = String(error?.message || error);
        if (!message.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") || attempt === maxPaginationRestarts) throw error;
      }
    }
    if (!completed) throw new Error("Plaid transaction pagination did not complete; cursor was not advanced.");
  }

  // ---- Plaid: current state of the verification window (read-only) ----
  const windowDays = options.backfillDays || IMPORT_WINDOW_DAYS;
  const windowImport: "all" | "pending" | "none" = options.windowImport
    || (isCard || options.accountSetting?.backfill_enabled ? "all" : "none");
  let windowTxns: PlaidTransaction[] = [];
  let windowOk = false;
  let windowNote: string | null = null;
  let windowStart = "";
  // Never create POSTED rows dated before bootstrap: the YNAB starting balance set at
  // bootstrap already includes them.
  const bootstrapDate = options.importFloor || (await env.SYNC_STATE.get(`bootstrap_date:${pid}`)) || "";
  let importStart = toIsoDate(new Date(Date.now() - windowDays * 86400000));
  if (bootstrapDate > importStart) importStart = bootstrapDate;
  try {
    const w = await getRecentRawTransactionsDetailed(env, acct, Math.max(windowDays, VERIFY_WINDOW_DAYS), 500);
    windowStart = w.start_date;
    windowOk = !w.truncated;
    if (w.truncated) {
      // A partial snapshot is not evidence of absence and must not participate in
      // ownership, matching, or imports. Cursor deltas remain usable; the snapshot-
      // dependent retirement/verification path stays disabled for this run.
      windowTxns = [];
      windowNote = `verification window exceeded its safe pagination budget; partial results discarded and pending retirement paused`;
    } else {
      windowTxns = w.transactions.filter(t => t.account_id === pid);
    }
  } catch (e: any) {
    windowNote = `verification window unavailable (${friendlyErrorMessage(e)}); pending retirement paused`;
  }
  const windowIds = new Set(windowTxns.map(t => t.transaction_id));

  // ---- Current state per lifecycle key. Later sources win, posted beats pending. ----
  const current = new Map<string, PlaidTransaction>();
  const creatable = new Set<string>();
  const consider = (t: PlaidTransaction, canCreate: boolean) => {
    // A pending charge Plaid removed (dropped, or replaced by a posted version) is
    // not current, unless the window still shows it pending right now.
    if (t.pending && removedIds.has(t.transaction_id) && !windowIds.has(t.transaction_id)) return;
    const L = lifecycleKey(t);
    const prev = current.get(L);
    if (prev && !prev.pending && t.pending) return;
    current.set(L, t);
    if (canCreate) creatable.add(L);
  };
  // Lost cursor on an account that was already set up (a KV edit, a restore): Plaid
  // replays the whole history, most of it already inside the YNAB starting balance.
  // Only pending charges are created from that replay; posted ones are left to the
  // import window, which checks them against YNAB first.
  const cursorLost = !cursorAtStart && !options.backfillOnly && (await env.SYNC_STATE.get(`bootstrapped:${pid}`)) === "1";
  if (cursorLost) logEvent(events, { account: acct.nickname, action: "cursor_rebuilt", detail: "The saved bank position was missing, so bank history was replayed. Only pending charges and the recent window were imported; nothing older was re-created." });
  for (const t of added) consider(t, !cursorLost || t.pending);
  for (const t of modified) consider(t, !cursorLost || t.pending);
  for (const t of windowTxns) {
    const inImport = t.pending || t.date >= importStart;
    consider(t, (inImport && (windowImport === "all" || (windowImport === "pending" && t.pending))) || creatable.has(lifecycleKey(t)));
  }
  // A posted charge whose first import id YNAB refused (it had seen that id before,
  // e.g. a same-amount row you deleted that day) stays creatable, so the next run
  // tries the next free id, until MAX_MINT_ATTEMPTS. Otherwise, once the bank cursor
  // moved past it, it would never be tried again.
  for (const t of windowTxns) {
    const tries = Number(String(rejectedIds[`tx:${t.transaction_id}`] || "").split("#")[1] || 0);
    if (!t.pending && tries > 0 && tries < MAX_MINT_ATTEMPTS && current.get(lifecycleKey(t))?.transaction_id === t.transaction_id) creatable.add(lifecycleKey(t));
  }
  const currentPendingL = new Set<string>();
  for (const [L, t] of current) if (t.pending) currentPendingL.add(L);

  interface Item { L: string; t: PlaidTransaction; spec: DesiredSpec; row: YNABExistingTransaction | null; via?: string; }
  const items: Item[] = [];
  const skipped: SkippedIncomeRecord[] = [];
  const inSidePosted: PlaidTransaction[] = [];   // card side of a card payment, posted at the bank
  const rulePosted: PlaidTransaction[] = [];     // skipped by your rules (front-loaded), posted at the bank
  const heldTransfers: PlaidTransaction[] = [];  // payments/transfers held only because YNAB's account list couldn't be read
  for (const [L, t] of current) {
    const spec = desiredForPlaid(t, acct, skipRules, ctx);
    if (spec.skip && !t.pending && isInSideKind(spec.skipKind)) inSidePosted.push(t);
    if (spec.skip && !t.pending && spec.skipKind === "rule") rulePosted.push(t);
    if (spec.skip && isHeldTransferKind(spec.skipKind)) heldTransfers.push(t);
    if (spec.skip) {
      // Only YOUR skip rules are recorded. Card-side payments are routine bookkeeping
      // (the payment is booked once, from checking, as a transfer) and aren't listed.
      if (spec.skipKind === "rule") {
        skipped.push({ ts: new Date().toISOString(), account: acct.nickname, payee: safePayee(t), amount: Math.abs(t.amount), date: t.date, reason: spec.skip });
      }
      continue;
    }
    items.push({ L, t, spec, row: null });
  }
  items.sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : 0));

  // ---- YNAB register + ownership ----
  // The snapshot must reach back past every charge this run could create; otherwise a
  // charge replayed after a long outage finds nothing to dedupe against and is written
  // twice. Normally that is the usual lookback; for older charges it is widened to 5
  // days before the oldest, capped at IDENTITY_HORIZON_DAYS.
  const today = todayInTimeZone(env);
  const horizonFloor = toIsoDate(new Date(Date.now() - IDENTITY_HORIZON_DAYS * 86400000));
  let snapshotStart = lookbackDate(env);
  for (const it of items) {
    if (!creatable.has(it.L)) continue;
    const need = toIsoDate(new Date(Date.parse(`${it.t.date}T00:00:00Z`) - SNAPSHOT_MARGIN_DAYS * 86400000));
    if (need < snapshotStart) snapshotStart = need;
  }
  if (snapshotStart < horizonFloor) snapshotStart = horizonFloor;
  // Charges too old to check against YNAB for a duplicate are never created.
  const tooOldBefore = toIsoDate(new Date(Date.parse(`${snapshotStart}T00:00:00Z`) + SNAPSHOT_MARGIN_DAYS * 86400000));
  const snapshot = await ynabGetAccountTransactions(env, acct.ynab_account_id, snapshotStart);
  const snapshotIds = new Set(snapshot.map(r => r.id));
  const snapshotImportIds = new Set(snapshot.map(r => r.import_id).filter(Boolean) as string[]);
  // A previous run died between YNAB saving its new rows and recording them for undo:
  // record the rows it created now (found by their import ids), as that run's entry.
  const undoIntentKey = `undo_intent:${pid}`;
  if (!options.dryRun) {
    const intent = await readJson(env, undoIntentKey, null);
    if (intent && Array.isArray(intent.import_ids)) {
      const wanted = new Set<string>(intent.import_ids);
      const made = snapshot.filter(r => r.import_id && wanted.has(r.import_id));
      const undoLog = await getUndoLog(env);
      const already = new Set(undoLog.flatMap(b => b.items.map(i => i.id)));
      const missing = made.filter(r => !already.has(r.id));
      if (missing.length) await appendUndo(env, `recovered-${intent.run_id || crypto.randomUUID()}`, intent.trigger || "unknown", missing.map(r => ({ id: r.id, account: acct.nickname })));
      await env.SYNC_STATE.delete(undoIntentKey);
    }
  }
  // A posted charge Plaid has removed (a bank revision re-sends it under a new id)
  // no longer owns its row, so the replacement can claim that row instead of
  // creating a second copy.
  const livePosted: Record<string, string> = {};
  for (const [k, v] of Object.entries(postedMap)) if (!removedIds.has(k)) livePosted[k] = v;
  const own = buildOwnership(acct, snapshot, links, livePosted, legacyPendingMap, [...current.values()], epoch, [...removedIds].filter(k => !current.has(k)));
  const mintedPosted = new Set(Object.values(postedMap));
  const isWorkerRow = (r: YNABExistingTransaction) => isWorkerImportPrefix(r.import_id) || (!!r.import_id && mintedPosted.has(r.import_id));

  // Pins and refused ids are kept for the whole identity horizon, not just the usual
  // lookback, so a charge replayed after an outage still finds the row it owns.
  let postedPersisted = postedJsonAtStart;
  const persistPostedMap = async () => {
    const pruned = prunePostedMap(postedMap, horizonFloor);
    const j = JSON.stringify(pruned);
    if (j !== postedPersisted) { await env.SYNC_STATE.put(postedKey, j); postedPersisted = j; }
  };
  const persistRejected = async () => {
    for (const [id, d] of Object.entries(rejectedIds)) if (String(d).slice(0, 10) < horizonFloor) delete rejectedIds[id];
    await env.SYNC_STATE.put(rejectedKey, JSON.stringify(rejectedIds));
  };

  const claimed = new Set<string>();
  const claim = (it: Item, row: YNABExistingTransaction, via: string) => {
    it.row = row; it.via = via; claimed.add(row.id);
  };

  // P1 ownership
  for (const it of items) {
    const r = own.rowFor(it.t);
    if (r && !claimed.has(r.id)) claim(it, r, "owned");
  }

  // P2 posted charge -> orphaned worker pending row (renamed, or pending link nulled)
  // Every identity a charge the bank currently reports goes by.
  const liveKeys = new Set<string>();
  for (const t of current.values()) { liveKeys.add(lifecycleKey(t)); liveKeys.add("tx:" + t.transaction_id); if (t.pending_transaction_id) liveKeys.add(t.pending_transaction_id); }
  // A row whose owner is a charge the bank no longer reports at all (a pending charge
  // that later posted under a new id without linking back) is no longer held by that
  // owner. Only judged when the full bank window was read (otherwise every charge
  // outside this run's changes would look gone) and only for rows well inside it.
  const staleFloor = windowStart ? toIsoDate(new Date(Date.parse(`${windowStart}T00:00:00Z`) + SNAPSHOT_MARGIN_DAYS * 86400000)) : "9999-12-31";
  const staleOwner = (r: YNABExistingTransaction) => {
    const owner = own.ownerOf.get(r.id);
    return !!owner && windowOk && r.date >= staleFloor && !liveKeys.has(owner);
  };
  const ownedByLiveOther = (r: YNABExistingTransaction, t: PlaidTransaction) => own.isOwnedByOther(r, t) && !staleOwner(r);
  const orphanPending = (r: YNABExistingTransaction) => {
    if (claimed.has(r.id)) return false;
    const owner = own.ownerOf.get(r.id);
    // A pending row whose pending charge the bank no longer shows. That is only known
    // when the full window was read, or when Plaid said outright it removed that
    // charge; otherwise a charge still pending from an earlier run just isn't in this
    // run's changes, and its row must not be handed to another charge.
    if (isWorkerPendingRow(r)) return (!owner || !currentPendingL.has(owner)) && (windowOk || (!!owner && removedIds.has(owner)));
    // A pending row the worker created that YOU already marked cleared (or
    // reconciled) before the bank posted it. If the bank then posts it under a new id
    // without linking it back, the row still belongs to that charge: its old pending
    // charge is gone, so nothing else owns it. (Before, this created a second posted
    // row, and deleting that duplicate left the bank charge unmatched for good.)
    return isWorkerPendingOrigin(r) && r.cleared !== "uncleared" && windowOk && r.date >= staleFloor && (!owner || !liveKeys.has(owner));
  };
  // A posted row the worker imported for a charge Plaid has just removed: the bank
  // re-sends a posted charge under a new id, sometimes at a new amount (a tip).
  const removedPostedIds = new Set<string>();
  for (const k of removedIds) {
    if (postedMap[k]) removedPostedIds.add(postedMap[k]);
    if (isCard) removedPostedIds.add(cardPostedImportId(k, epoch));
  }
  const orphanPosted = (r: YNABExistingTransaction) => !claimed.has(r.id) && r.cleared !== "uncleared" && !!r.import_id && removedPostedIds.has(r.import_id);
  for (const it of items) {
    if (it.row || it.t.pending || !it.spec.row) continue;
    const target = it.spec.row.amount;
    // (a) exact amount, unique, within 3 days of the posted date, or dated exactly on
    // the day Plaid says the charge was made (authorized_date; a card charge can post
    // a week later under a new name, ABC FITNESS -> CRUNCH FITNESS): name-independent.
    // A pending TRANSFER row (a card payment booked early) only ever belongs to a
    // payment to that same account: a cancelled $300 card payment's row must never be
    // taken by a $300 Amex payment or a $300 check that posts the same day.
    const sameKind = (r: YNABExistingTransaction) => !r.transfer_transaction_id || (!!it.spec.row!.payee_id && r.payee_id === it.spec.row!.payee_id);
    const sameSign = (r: YNABExistingTransaction) => (orphanPending(r) || orphanPosted(r)) && sameKind(r) && (Number(r.amount) < 0) === (target < 0);
    const exact = snapshot.filter(r => sameSign(r) && Number(r.amount) === target &&
      (daysApart(r.date, it.t.date) <= 3 || (!!it.t.authorized_date && r.date === it.t.authorized_date)));
    if (exact.length === 1) { claim(it, exact[0], "posted_flip_exact"); continue; }
    // (b) amount drift (tips / auth adjustments) with a similar payee. A posted card
    // charge can be dated days after the pending one; Plaid's authorized_date is when
    // it was made, which is what the pending row carries. That wider reach is only
    // used together with a similar name, so a different charge of the same amount
    // can't take another charge's pending row.
    const gap = (r: YNABExistingTransaction) => Math.min(daysApart(r.date, it.t.date), it.t.authorized_date ? daysApart(r.date, it.t.authorized_date) : Infinity);
    const pool = snapshot.filter(r => sameSign(r) && gap(r) <= 4);
    const food = (it.t.pfc_primary || "").toUpperCase() === "FOOD_AND_DRINK";
    const tol = Math.max(5000, Math.abs(target) * (food ? 0.25 : 0.08));
    const names = [plaidPayeeText(it.t), normalizeMerchant(it.spec.row.payee_name)];
    let best: YNABExistingTransaction | null = null; let bestScore = Infinity;
    for (const r of pool) {
      // Transfers and card payments don't drift (no tips): only an exact amount, above.
      if (r.transfer_transaction_id) continue;
      const diff = Math.abs(Number(r.amount) - target);
      if (diff > tol) continue;
      const rn = normalizeMerchant(r.payee_name || "");
      if (!names.some(n => namesSimilar(n, rn, ctx.aliases))) continue;
      const score = diff * 100 + gap(r);
      if (score < bestScore) { bestScore = score; best = r; }
    }
    if (best) claim(it, best, "posted_flip_drift");
  }

  // P2p a charge still pending, re-sent by the bank under a new pending id: its old
  // pending row (that the bank no longer shows) is this charge's row, so the category
  // and memo you set stay. Exact amount, within 2 days, a similar payee, the only one.
  for (const it of items) {
    if (it.row || !it.t.pending || !it.spec.row) continue;
    const want = it.spec.row;
    const names = [plaidPayeeText(it.t), normalizeMerchant(want.payee_name)];
    const cands = snapshot.filter(r => isWorkerPendingRow(r) && orphanPending(r) && Number(r.amount) === want.amount && daysApart(r.date, it.t.date) <= 2 &&
      (r.transfer_transaction_id ? (!!want.payee_id && r.payee_id === want.payee_id) : names.some(n => namesSimilar(n, normalizeMerchant(r.payee_name || ""), ctx.aliases))));
    if (cands.length === 1) claim(it, cands[0], "pending_reissued");
  }

  const newLinks: Record<string, string> = {};
  // A worker row being replaced by another row (the transfer's leg, your own entry):
  // if YNAB won't delete it this run, the switch is undone so the next run retries
  // the delete instead of leaving both rows in place.
  const replacedFor = new Map<string, string>();
  const deletes: { row: YNABExistingTransaction; reason: string }[] = [];
  const deleteIds = new Set<string>();

  // P2b money in from another of your accounts: when that transfer is already booked
  // in YNAB (from the sending account), its leg here is the row. See transferLegFor.
  if (!isCard) {
    const legEligible = (it: Item) => (r: YNABExistingTransaction) =>
      !claimed.has(r.id) && !deleteIds.has(r.id) && !ownedByLiveOther(r, it.t);
    // Named transfers first, so an unnamed deposit can never take their leg.
    const inflows = items.filter(it => it.t.amount < 0 && !!it.spec.row).sort((a, b) => Number(!a.spec.transferFrom) - Number(!b.spec.transferFrom));
    for (const it of inflows) {
      const hasWorkerCopy = !!it.row && isWorkerRow(it.row) && it.row.cleared !== "reconciled";
      if (it.row && !hasWorkerCopy) continue;
      // A copy the worker imported earlier is only replaced for a transfer the bank
      // text names; an unnamed deposit that already has its row is left alone.
      if (hasWorkerCopy && !it.spec.transferFrom) continue;
      const leg = transferLegFor(it.t, it.spec, acct, snapshot, legEligible(it), ctx,
        inflows.filter(o => o !== it && !o.row && !o.spec.transferFrom).map(o => o.t));
      if (!leg) continue;
      if (hasWorkerCopy) {
        deletes.push({ row: it.row!, reason: "the transfer from your other account is booked; its leg is this deposit" });
        deleteIds.add(it.row!.id);
        claimed.delete(it.row!.id);
        replacedFor.set(it.row!.id, it.L);
      }
      claim(it, leg, "transfer_leg");
      newLinks[it.L] = leg.id;
    }
  }

  // P3 content fallback against unowned rows (manual entries, Direct Import, rows
  // imported before ownership was tracked). Worker pending rows are never matched by
  // content; they belong to P1/P2/P7. A charge still pending at the bank is never
  // matched to a Direct Import row that is already CLEARED: that row is a posted
  // charge, so it's a different (older) one. (Direct Import also brings in pending
  // charges, as uncleared rows; those can match.) Posted charges are matched first.
  const contentEligible = (t: PlaidTransaction) => (r: YNABExistingTransaction) =>
    !claimed.has(r.id) && !deleteIds.has(r.id) && !isWorkerPendingRow(r) && !ownedByLiveOther(r, t) &&
    // Without the full bank window the worker can't tell which charge owns one of its
    // own rows, so it never hands one to a different charge by name and amount.
    !(!windowOk && isWorkerImportPrefix(r.import_id)) &&
    !(t.pending && isDirectImportRow(r) && r.cleared !== "uncleared");
  function isDirectImportRow(r: YNABExistingTransaction): boolean { return String(r.import_id || "").startsWith("YNAB:") && !isWorkerRow(r); }
  const p3Order = [...items.filter(i => !i.t.pending), ...items.filter(i => i.t.pending)];
  // Charges this run decided were already in YNAB as a row the worker didn't make.
  // Nothing is created for them, so they are logged; otherwise the charge just looks
  // missing with no trace of why.
  const matchedExisting: { it: Item; row: YNABExistingTransaction; how: string }[] = [];
  // Direct Import rows first, by the bank amount and date recorded in their import
  // ids: stronger evidence than a name (two same-amount charges at one merchant a day
  // apart are told apart by date; a renamed row still pairs).
  for (const [it, r] of directImportPairs(items.filter(i => !i.row && !!i.spec.row && !i.spec.row.payee_id), snapshot, (r, i) => contentEligible(i.t)(r), isDirectImportRow)) {
    if (claimed.has(r.id) || it.row) continue;
    claim(it, r, "content_amount"); newLinks[it.L] = r.id;
    matchedExisting.push({ it, row: r, how: "same amount and date as Direct Import's row" });
  }
  for (const strength of ["strong", "leading_word"] as const) {
    for (const it of p3Order) {
      if (it.row) continue;
      const m = contentMatch(it.t, it.spec, snapshot, contentEligible(it.t), ctx.aliases, strength);
      if (m) { claim(it, m, "content"); newLinks[it.L] = m.id; matchedExisting.push({ it, row: m, how: "same amount and payee" }); }
    }
  }
  for (const [it, r] of uniqueAmountPairs(items.filter(i => !i.row && !!i.spec.row && !i.spec.row.payee_id), snapshot, (r, i) => contentEligible(i.t)(r), ctx.aliases, isDirectImportRow)) {
    if (claimed.has(r.id)) continue;
    claim(it, r, "content_amount"); newLinks[it.L] = r.id;
    matchedExisting.push({ it, row: r, how: "same amount" });
  }

  // P4 duplicate race: a worker row plus an unowned non-worker row for the same
  // charge (a manual entry, or Direct Import posting before the worker flipped).
  // The non-worker row survives; the worker copy is removed.
  for (const it of items) {
    // Only the pending race this phase exists for: the worker's row is still pending
    // when your entry (or Direct Import's) shows up. A worker row that already posted
    // is a settled charge; a later hand entry with the same amount is a NEW purchase.
    if (!it.row || !isWorkerRow(it.row) || it.row.cleared !== "uncleared") continue;
    const eligible = (r: YNABExistingTransaction) =>
      contentEligible(it.t)(r) && !isWorkerRow(r) && r.id !== it.row!.id;
    const theirs = contentMatch(it.t, it.spec, snapshot, eligible, ctx.aliases);
    if (!theirs) continue;
    deletes.push({ row: it.row, reason: `duplicate of a non-worker row (${theirs.payee_name || "manual/Direct Import"})` });
    deleteIds.add(it.row.id);
    replacedFor.set(it.row.id, it.L);
    claimed.add(theirs.id);
    it.row = theirs; it.via = "race_non_worker";
    newLinks[it.L] = theirs.id;
  }

  // Without the YNAB account list the worker can't tell whether a payment goes to a
  // tracked card, and a payment booked as a plain outflow is never corrected later.
  // Stop this account for this run instead (nothing written, cursor unchanged); the
  // next run books it properly.
  if (!ctx.ok && !isCard && (items.some(it => !it.row && creatable.has(it.L) && !it.t.pending && classifyTransfer(it.t) === "card_payment") ||
      heldTransfers.length > 0)) {
    throw new Error("YNAB account list unavailable, so a card payment can't be booked as a transfer yet. Nothing was written; the next sync will book it.");
  }
  // Same for a transfer to your other account while that account's last 4 is still
  // unknown (the bank lookup failed): booked as a plain outflow it would never be
  // corrected, so wait for a run where the lookup works.
  const unknownOthers = ctx.masksMissing.filter(n => n !== acct.nickname);
  if (!isCard && unknownOthers.length > 0 && items.some(it => !it.row && creatable.has(it.L) && !it.t.pending && it.t.amount > 0 &&
      !it.spec.row?.payee_id && isTransferLooking(it.t) && accountRefsIn(it.t).length > 0)) {
    throw new Error(`Couldn't read the account numbers for ${unknownOthers.join(", ")} from the bank, so a transfer between your accounts can't be recognized yet. Nothing was written; the next sync retries.`);
  }

  // P5 updates on worker rows; P6 creates
  const updates: any[] = [];
  const creates: YNABTransaction[] = [];
  const createFor = new Map<string, Item>();
  const occCounts = seedOccurrenceCounts(snapshot);
  const plannedImportIds = new Set<string>();

  // Checking posted ids minted this run (import id -> charge). They are pinned in
  // postedMap only once YNAB accepts them; a refused one is not pinned, so the next
  // run mints the next free occurrence instead of orphaning the charge.
  const freshMints = new Map<string, string>();
  const tooOld: Item[] = [];
  const attemptsKey = (txId: string) => `tx:${txId}`;
  const mintAttempts = (txId: string) => Number(String(rejectedIds[attemptsKey(txId)] || "").split("#")[1] || 0);

  const queueCreate = (it: Item) => {
    const want = it.spec.row!;
    if (it.t.date < tooOldBefore) { tooOld.push(it); return; }
    let importId: string;
    if (it.t.pending) {
      importId = expectedPendingImportId(acct, it.L, epoch);
    } else if (isCard) {
      importId = cardPostedImportId(it.L, epoch);
    } else if (postedMap[it.t.transaction_id]) {
      // Pinned: YNAB accepted this id for this charge before. If YNAB now refuses it,
      // the row was deleted in YNAB on purpose, and that is respected.
      importId = postedMap[it.t.transaction_id];
    } else {
      if (mintAttempts(it.t.transaction_id) >= MAX_MINT_ATTEMPTS) return;
      // Skip ids YNAB has refused before (a deleted row leaves a gap in YNAB's
      // numbering) and ids already present, so a new charge never inherits one.
      let occ = nextOccurrence(occCounts, want.amount, want.date);
      importId = ynabImportId(want.amount, want.date, occ);
      for (let i = 0; i < 10 && (rejectedIds[importId] || snapshotImportIds.has(importId) || plannedImportIds.has(importId)); i++) {
        occ = nextOccurrence(occCounts, want.amount, want.date);
        importId = ynabImportId(want.amount, want.date, occ);
      }
      freshMints.set(importId, it.t.transaction_id);
    }
    if (plannedImportIds.has(importId) || rejectedIds[importId]) return;
    const existingSameId = snapshot.find(r => r.import_id === importId);
    if (existingSameId && !deleteIds.has(existingSameId.id)) return; // already there
    plannedImportIds.add(importId);
    const row: YNABTransaction = {
      account_id: want.account_id, date: want.date, amount: want.amount,
      payee_name: want.payee_name, cleared: want.cleared, approved: false,
      import_id: importId, memo: want.memo
    };
    if (want.payee_id) row.payee_id = want.payee_id;
    creates.push(row);
    createFor.set(importId, it);
  };

  for (const it of items) {
    const want = it.spec.row!;
    if (!it.row) {
      if (creatable.has(it.L)) queueCreate(it);
      continue;
    }
    const r = it.row;
    // Your own row (or a transfer you entered) that represents this charge: once the
    // bank shows the charge POSTED at the same amount, mark it cleared, the way Direct
    // Import would. Only the cleared flag changes; payee, category, memo, amount and
    // date stay exactly as you entered them. A different amount is left alone for you
    // to look at.
    if (!isWorkerRow(r) && r.cleared === "uncleared" && !it.t.pending && Number(r.amount) === want.amount && !deleteIds.has(r.id)) {
      updates.push({ id: r.id, account_id: acct.ynab_account_id, cleared: "cleared", _via: "posted_at_bank", _payee: r.payee_name || want.payee_name });
      if (it.via !== "owned") newLinks[it.L] = r.id;
      continue;
    }
    if (!isWorkerRow(r) || r.cleared === "reconciled" || deleteIds.has(r.id)) continue; // never otherwise edit manual / DI / reconciled rows

    // A pending worker row whose charge posted as a tracked card payment must become a
    // real transfer. The payee can't be changed into a transfer in place, so replace it.
    if (want.payee_id && !r.transfer_transaction_id && r.cleared === "uncleared") {
      deletes.push({ row: r, reason: "replaced by checking -> card transfer" });
      deleteIds.add(r.id);
      it.row = null;
      queueCreate(it);
      continue;
    }

    const patch: any = {};
    if (r.cleared === "uncleared") {
      if (want.cleared === "cleared") patch.cleared = "cleared";
      if (Number(r.amount) !== want.amount) patch.amount = want.amount;
      if (r.date !== want.date) patch.date = want.date;
      if (want.cleared === "cleared" && String(r.memo || "").toLowerCase() === "pending") patch.memo = null;
    } else if (!it.t.pending && Number(r.amount) !== want.amount) {
      patch.amount = want.amount; // Plaid modified a posted amount
    }
    // A row you marked cleared yourself while the charge was still pending keeps the
    // worker's "Pending" note; once the bank posts it, the note is wrong, so drop it.
    if (r.cleared === "cleared" && !it.t.pending && String(r.memo || "").toLowerCase() === "pending") patch.memo = null;
    if (Object.keys(patch).length > 0) {
      updates.push({ id: r.id, account_id: acct.ynab_account_id, ...patch, _via: it.via, _payee: r.payee_name || want.payee_name });
    }
    if (it.via !== "owned") newLinks[it.L] = r.id; // remember flips so next run is P1
  }

  // Card accounts: when the worker books a checking -> card payment, YNAB creates the
  // card-side leg as uncleared. The payment has already happened, so clear it. Only
  // legs whose checking side the WORKER created are touched; a transfer you enter
  // yourself (or a scheduled one) is left exactly as you made it.
  // Legs already found NOT to come from a worker payment are remembered, so each one
  // costs a single YNAB lookup rather than one every run.
  const legCacheKey = `legs_not_worker:${pid}`;
  const legCache: Record<string, string> = isCard ? await readJson(env, legCacheKey, {}) : {};
  let legCacheChanged = false;
  {
    // The card's own "Payment Thank You", POSTED: it is the card side of exactly one
    // transfer from your checking account, and that transfer's leg here is marked
    // cleared. Each thank-you is tied to its leg (remembered as a link), so once it
    // has cleared its own leg it can never clear a second one (next week's $200
    // payment that is still on its way). A leg cleared before links were kept counts
    // as that thank-you's leg when it is the closest match. Closest date wins.
    const payers = new Set(ctx.accounts.filter(a => !isCreditCardAccount(a)).map(a => a.ynab_account_id));
    // Legs already tied to a thank-you the bank still reports. A link whose thank-you
    // is gone (re-sent under a new id) doesn't hold its leg, so the re-sent one can
    // take it back instead of grabbing the next payment's leg.
    const linkedLegIds = new Set<string>();
    // (Without the full bank window, which thank-yous are gone isn't known: every link holds.)
    for (const [k, v] of Object.entries({ ...links, ...newLinks })) if (!windowOk || liveKeys.has(k)) linkedLegIds.add(v);
    const isLeg = (r: YNABExistingTransaction) => !deleteIds.has(r.id) && !!r.transfer_transaction_id && Number(r.amount || 0) > 0 &&
      (!r.transfer_account_id || payers.has(r.transfer_account_id));
    const byId = new Map(snapshot.map(r => [r.id, r]));
    const unlinked: PlaidTransaction[] = [];
    for (const t of inSidePosted) {
      const L = lifecycleKey(t);
      const mine = links[L] ? byId.get(links[L]) : undefined;
      if (mine && isLeg(mine)) {
        claimed.add(mine.id);
        if (mine.cleared === "uncleared") updates.push({ id: mine.id, account_id: acct.ynab_account_id, cleared: "cleared", _via: "payment_posted_at_bank", _payee: mine.payee_name });
        continue;
      }
      unlinked.push(t);
    }
    // Pair the rest one-to-one, best pairs first: a leg whose sending side has
    // already posted beats one still pending at the sending bank (the card can't
    // have received money the bank hasn't sent), then the closest dates.
    type Pair = { t: PlaidTransaction; leg: YNABExistingTransaction; d: number; pendingSide: boolean };
    const pairs: Pair[] = [];
    for (const t of unlinked) {
      const milli = Math.round(-t.amount * 1000);
      for (const r of snapshot) {
        if (!isLeg(r) || claimed.has(r.id) || linkedLegIds.has(r.id) || Number(r.amount) !== milli || daysApart(r.date, t.date) > CARD_PAYMENT_POSTING_DAYS) continue;
        pairs.push({ t, leg: r, d: daysApart(r.date, t.date), pendingSide: false });
      }
    }
    const legChoices = new Map<string, number>(); const tChoices = new Map<string, number>(); const unknownT = new Set<string>();
    for (const p of pairs) { legChoices.set(p.leg.id, (legChoices.get(p.leg.id) || 0) + 1); tChoices.set(p.t.transaction_id, (tChoices.get(p.t.transaction_id) || 0) + 1); }
    for (const p of pairs) {
      // Look at the sending side (one read) when there is a choice to make, or when
      // the leg is dated after the thank-you.
      const choice = (legChoices.get(p.leg.id) || 0) > 1 || (tChoices.get(p.t.transaction_id) || 0) > 1;
      if (p.leg.cleared !== "uncleared" || !(choice || p.leg.date > p.t.date)) continue;
      try { const other = await ynabGetTransaction(env, p.leg.transfer_transaction_id!); p.pendingSide = !!other && other.cleared === "uncleared"; }
      catch { unknownT.add(p.t.transaction_id); } // can't tell which payment it is right now: decide on a later run
    }
    for (let i = pairs.length - 1; i >= 0; i--) if (unknownT.has(pairs[i].t.transaction_id)) pairs.splice(i, 1);
    // A payment sent AFTER the card already showed this thank-you, and still pending
    // at the sending bank, can't be what the thank-you is for (it's a different
    // payment that hasn't arrived yet).
    for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i].pendingSide && pairs[i].leg.date > pairs[i].t.date) pairs.splice(i, 1);
    pairs.sort((x, y) => Number(x.pendingSide) - Number(y.pendingSide) || x.d - y.d || (x.leg.cleared === "uncleared" ? 1 : 0) - (y.leg.cleared === "uncleared" ? 1 : 0));
    const pairedT = new Set<string>();
    for (const p of pairs) {
      if (pairedT.has(p.t.transaction_id) || claimed.has(p.leg.id)) continue;
      pairedT.add(p.t.transaction_id); claimed.add(p.leg.id); linkedLegIds.add(p.leg.id);
      newLinks[lifecycleKey(p.t)] = p.leg.id;
      if (p.leg.cleared === "uncleared") updates.push({ id: p.leg.id, account_id: acct.ynab_account_id, cleared: "cleared", _via: "payment_posted_at_bank", _payee: p.leg.payee_name });
    }
    for (const t of unlinked) {
      if (pairedT.has(t.transaction_id)) continue;
      const milli = Math.round(-t.amount * 1000);
      // No transfer for this payment. If it is already in YNAB as a plain payment
      // row (Direct Import brought it in before the switch, or you entered it), that
      // row is it. Otherwise nothing is imported: the payment came from an account
      // the worker doesn't sync, or that account's feed is late, and guessing would
      // risk counting it twice. The health check flags it after 5 days.
      const plain = snapshot.filter(r => !claimed.has(r.id) && !deleteIds.has(r.id) && !r.transfer_transaction_id && Number(r.amount) === milli &&
        daysApart(r.date, t.date) <= CARD_PAYMENT_POSTING_DAYS && !ownedByLiveOther(r, t) &&
        (/PAYMENT|THANK|AUTOPAY|PMT/i.test(String(r.payee_name || "")) || isDirectImportRow(r)))
        .sort((a, b) => daysApart(a.date, t.date) - daysApart(b.date, t.date));
      if (plain.length) { claimed.add(plain[0].id); newLinks[lifecycleKey(t)] = plain[0].id; }
    }
  }

  // A row you entered ahead of the bank (a front-loaded paycheck) that your skip rule
  // keeps the worker from importing: once the bank shows it POSTED at exactly that
  // amount, mark your row cleared (only the cleared flag). A different amount is left
  // for you to adjust.
  for (const t of rulePosted) {
    const milli = Math.round(-t.amount * 1000);
    const bankName = plaidPayeeText(t);
    const cands = snapshot.filter(r => !claimed.has(r.id) && !deleteIds.has(r.id) && r.cleared === "uncleared" && !isWorkerRow(r) && !r.transfer_transaction_id &&
      Number(r.amount) === milli && daysApart(r.date, t.date) <= CARD_PAYMENT_POSTING_DAYS &&
      // Only your row for THIS charge (same payee), never another row that happens
      // to have the same amount.
      (namesSimilar(bankName, normalizeMerchant(r.payee_name || ""), ctx.aliases) || leadingWordMatch(bankName, normalizeMerchant(r.payee_name || ""), ctx.aliases)));
    if (cands.length !== 1) continue;
    claimed.add(cands[0].id);
    updates.push({ id: cands[0].id, account_id: acct.ynab_account_id, cleared: "cleared", _via: "posted_at_bank", _payee: cands[0].payee_name });
  }

  if (isCard) {
    for (const id of Object.keys(legCache)) if (!snapshotIds.has(id)) { delete legCache[id]; legCacheChanged = true; }
    const legs = snapshot.filter(r => !claimed.has(r.id) && r.transfer_transaction_id && Number(r.amount || 0) > 0 && r.cleared === "uncleared" && !legCache[r.id]);
    if (legs.length > 0) {
      const mintedByAccount = new Map<string, Set<string>>();
      for (const a of ctx.accounts) {
        if (isCreditCardAccount(a) || !settingForAccount(ctx.settings, a).sync_enabled) continue;
        const pm: Record<string, string> = await readJson(env, `posted:${a.plaid_account_id}`, {});
        mintedByAccount.set(a.ynab_account_id, new Set(Object.values(pm)));
      }
      for (const r of legs) {
        let other: YNABExistingTransaction | null;
        try { other = await ynabGetTransaction(env, r.transfer_transaction_id!); }
        catch { continue; } // YNAB unavailable for this read: decide on a later run
        if (!other) continue;
        const minted = other ? mintedByAccount.get(other.account_id) : undefined;
        // Normally the card's own thank-you clears its leg (above). This is only a
        // fallback for a payment the card never itemizes as a thank-you: the worker's
        // checking side posted at least CARD_PAYMENT_POSTING_DAYS ago.
        const workerPosted = !!other && !!other.import_id && ((!!minted && minted.has(other.import_id)) ||
          (isWorkerPendingOrigin(other) && other.cleared !== "uncleared"));
        if (other && workerPosted) {
          if (daysApart(other.date, today) >= CARD_PAYMENT_POSTING_DAYS) { claimed.add(r.id); updates.push({ id: r.id, account_id: acct.ynab_account_id, cleared: "cleared", _via: "card_leg", _payee: r.payee_name }); }
          continue;
        }
        if (!other || !minted || !other.import_id || !minted.has(other.import_id)) {
          // Only a definite answer is cached: the other side exists and isn't the
          // worker's (a transfer you entered, or a scheduled one).
          if (other && minted && !isWorkerImportPrefix(other.import_id) && !minted.has(other.import_id || "")) { legCache[r.id] = today; legCacheChanged = true; }
          continue;
        }
      }
    }
  }

  // P7 retire worker pending rows the bank no longer shows as pending
  for (const r of snapshot) {
    if (claimed.has(r.id) || deleteIds.has(r.id) || !isWorkerPendingRow(r)) continue;
    const owner = own.ownerOf.get(r.id);
    if (owner && currentPendingL.has(owner)) continue; // still pending (possibly skipped) -> keep
    let reason: string | null = null;
    if (windowOk) {
      if (r.date > windowStart) reason = "no longer pending at the bank";
      else if (calendarDaysBetween(r.date, today) >= STALE_PENDING_DAYS) reason = "stale, older than the verification window";
    } else if (owner && removedIds.has(owner)) {
      reason = "Plaid removed the pending charge";
    }
    if (reason) { deletes.push({ row: r, reason }); deleteIds.add(r.id); }
  }

  const plan = {
    creates: creates.map(c => ({ date: c.date, payee_name: c.payee_name || (c.payee_id ? "(transfer to card)" : ""), amount: c.amount, cleared: c.cleared, import_id: c.import_id, is_card_transfer: !!c.payee_id })),
    updates: updates.map(u => ({ id: u.id, payee: u._payee, change: Object.fromEntries(Object.entries(u).filter(([k]) => !["id", "account_id", "_via", "_payee"].includes(k))), via: u._via })),
    deletes: deletes.map(d => ({ id: d.row.id, date: d.row.date, payee: d.row.payee_name, amount: d.row.amount, reason: d.reason })),
    too_old: tooOld.map(it => ({ date: it.t.date, payee: safePayee(it.t), amount: it.spec.row!.amount })),
    matched_existing: matchedExisting.map(m => ({ bank_date: m.it.t.date, bank_payee: safePayee(m.it.t), amount: Math.round(-m.it.t.amount * 1000), ynab_row_date: m.row.date, ynab_row_payee: m.row.payee_name || "", how: m.how }))
  };

  const summaryBase = {
    mode: isCard ? "card" : "checking",
    added_count: added.length,
    modified_count: modified.length,
    removed_count: removedIds.size,
    window_days: windowDays,
    window_import: windowImport,
    window_ok: windowOk,
    window_note: windowNote,
    snapshot_start: snapshotStart,
    routing_ok: ctx.ok,
    skipped_front_loaded_income_count: skipped.length,
    skipped_front_loaded_income: skipped
  };

  if (options.dryRun) {
    return {
      status: options.backfillOnly ? "dry_run_backfill_only" : "dry_run",
      ...summaryBase,
      would_create_count: creates.length,
      would_update_count: updates.length,
      would_delete_count: deletes.length,
      plan,
      recent_imports: plan.creates.slice(0, 30)
    };
  }

  // Final pre-write check: rows that appeared in YNAB DURING this run (a manual entry
  // typed mid-sync) are the only thing the snapshot could have missed. Compare creates
  // against those new rows only, so a row can never match itself.
  if (creates.length > 0) {
    const fresh = await ynabGetAccountTransactions(env, acct.ynab_account_id, snapshotStart);
    const arrived = fresh.filter(r => !snapshotIds.has(r.id) && !isWorkerRow(r));
    if (arrived.length > 0) {
      const taken = new Set<string>();
      const kept: YNABTransaction[] = [];
      for (const c of creates) {
        const it = createFor.get(c.import_id)!;
        const m = contentMatch(it.t, it.spec, arrived, r => !taken.has(r.id), ctx.aliases);
        if (m) {
          taken.add(m.id);
          newLinks[it.L] = m.id;
          logEvent(events, { account: acct.nickname, action: "final_prewrite_dedupe", import_id: c.import_id, amount: c.amount, detail: `matched a row entered during the sync (${m.payee_name || ""})` });
          continue;
        }
        kept.push(c);
      }
      creates.splice(0, creates.length, ...kept);
    }
  }

  // Last check before writing: if sync was paused while this account was being
  // planned, write nothing and leave the cursor where it was.
  if (!(await isSyncEnabled(env))) {
    return { status: "paused - nothing written", ...summaryBase, would_create_count: creates.length, would_update_count: updates.length, would_delete_count: deletes.length };
  }

  // Writes: creates -> updates -> deletes.
  let createdResult: any = { added: 0, duplicates: 0, created_ids: [], duplicate_import_ids: [] };
  const rejected: string[] = [];
  if (creates.length > 0) {
    // Recorded BEFORE the create, so if this run dies right after YNAB saves the rows,
    // the next run can still add them to the undo list (see below).
    if (!options.dryRun) await env.SYNC_STATE.put(undoIntentKey, JSON.stringify({ run_id: options.runId || "", trigger: options.trigger || "unknown", import_ids: creates.map(c => c.import_id) }));
    createdResult = await ynabUpsert(env, creates);
    rejected.push(...(createdResult.duplicate_import_ids || []));
    // YNAB can save the rows and still answer with an error (a timeout); the retry
    // then reports them as duplicates. An id that wasn't in YNAB before this run but
    // is there now was created by this run, not refused.
    if (rejected.length > 0) {
      const after = await ynabGetAccountTransactions(env, acct.ynab_account_id, snapshotStart);
      const nowById = new Map(after.filter(r => r.import_id).map(r => [r.import_id as string, r]));
      for (const id of [...rejected]) {
        const r = nowById.get(id);
        if (!r || snapshotImportIds.has(id)) continue;
        rejected.splice(rejected.indexOf(id), 1);
        createdResult.created_ids = [...(createdResult.created_ids || []), r.id];
        createdResult.added = (createdResult.added || 0) + 1;
      }
    }
    const refused = new Set(rejected);
    for (const [importId, txId] of freshMints) {
      if (refused.has(importId)) {
        const n = mintAttempts(txId) + 1;
        rejectedIds[attemptsKey(txId)] = `${today}#${n}`;
        if (n >= MAX_MINT_ATTEMPTS) {
          const it = createFor.get(importId)!;
          logEvent(events, { account: acct.nickname, action: "import_gave_up", transaction_id: txId, amount: it.spec.row!.amount, detail: `${safePayee(it.t)} ${it.t.date}: YNAB refused ${n} import ids for this charge; add it by hand if it's real` });
        }
      } else {
        postedMap[txId] = importId;
      }
    }
    for (const id of rejected) rejectedIds[id] = today;
    // Persist what was just written before anything else can fail, so a later error
    // (an update YNAB refuses, a timeout) can't lose the pins or the undo record.
    await persistPostedMap();
    if (rejected.length > 0) await persistRejected();
    const createdIds: string[] = createdResult.created_ids || [];
    if (createdIds.length > 0) {
      await appendUndo(env, options.runId || crypto.randomUUID(), options.trigger || "unknown", createdIds.map(id => ({ id, account: acct.nickname })));
    }
    await env.SYNC_STATE.delete(undoIntentKey);
  }
  const cleanUpdates = updates.map(u => { const { _via, _payee, ...rest } = u; return rest; });
  const updatedResult = await ynabUpdateEach(env, cleanUpdates);
  const failedUpdateIds = new Set(updatedResult.failed.map(f => f.id));

  let deleted = 0;
  const deleteErrors: any[] = [];
  for (const d of deletes) {
    try { await ynabDeleteTransaction(env, d.row.id); deleted++; }
    catch (e: any) {
      deleteErrors.push({ id: d.row.id, error: e.message });
      const L = replacedFor.get(d.row.id);
      if (L) delete newLinks[L];
    }
  }

  for (const c of creates) {
    if (rejected.includes(c.import_id)) continue;
    const it = createFor.get(c.import_id)!;
    logEvent(events, {
      account: acct.nickname,
      action: c.payee_id ? "card_payment_transfer" : c.cleared === "uncleared" ? "pending_import" : "posted_import",
      transaction_id: it.t.transaction_id, import_id: c.import_id, amount: c.amount, detail: c.payee_name || "transfer"
    });
  }
  for (const m of matchedExisting) {
    logEvent(events, {
      account: acct.nickname, action: "matched_existing_row", transaction_id: m.it.t.transaction_id, amount: Math.round(-m.it.t.amount * 1000),
      detail: `${safePayee(m.it.t)} ${m.it.t.date}${m.it.t.pending ? " (pending)" : ""}: already in YNAB as your row "${m.row.payee_name || ""}" dated ${m.row.date} (${m.how}), so no new row. If that row is a different payment, add this one by hand.`
    });
  }
  for (const u of updates) {
    if (failedUpdateIds.has(u.id)) continue;
    const clearedYours = u._via === "posted_at_bank" || u._via === "payment_posted_at_bank";
    const how = VIA_WORDS[u._via] ?? "";
    logEvent(events, { account: acct.nickname, action: u._via === "card_leg" ? "cc_payment_leg_cleared" : clearedYours ? "marked_cleared" : (u.cleared === "cleared" ? "pending_flip" : "row_update"), transaction_id: u.id, import_id: snapshot.find(r => r.id === u.id)?.import_id || undefined, amount: u.amount ?? Number(snapshot.find(r => r.id === u.id)?.amount ?? 0), detail: `${u._payee || ""}${how ? ` (${how})` : ""}` });
  }
  // A row YNAB won't update or delete is logged once (not every run) and skipped; the
  // rest of the account keeps syncing, and the account is reported as "partial".
  // A 4xx is a real refusal you may need to fix in YNAB; anything else is temporary
  // and retried by the next sync.
  const failKey = `update_failed:${pid}`;
  const failedDeletes = new Set(deleteErrors.map(e => e.id));
  const anyWrites = updates.length + deletes.length > 0;
  const prevFailed: Record<string, string> = anyWrites ? await readJson(env, failKey, {}) : {};
  const nowFailed: Record<string, string> = {};
  const failureText = (error: string) => /failed: 4\d\d/.test(error)
    ? `${plainYnabError(error)}. Fix it in YNAB; the rest of the sync continues.`
    : `YNAB was unavailable (${plainYnabError(error)}). The next sync retries it.`;
  for (const f of updatedResult.failed) {
    nowFailed[f.id] = prevFailed[f.id] || today;
    if (!prevFailed[f.id]) {
      const u = updates.find(x => x.id === f.id);
      logEvent(events, { account: acct.nickname, action: "update_failed", transaction_id: f.id, amount: u?.amount, detail: `${u?._payee || ""}: ${failureText(f.error)}` });
    }
  }
  for (const f of deleteErrors) {
    nowFailed[f.id] = prevFailed[f.id] || today;
    if (!prevFailed[f.id]) {
      const d = deletes.find(x => x.row.id === f.id);
      logEvent(events, { account: acct.nickname, action: "delete_failed", transaction_id: f.id, amount: d ? Number(d.row.amount || 0) : undefined, detail: `${d?.row.payee_name || ""}: couldn't remove it. ${failureText(String(f.error || ""))}` });
    }
  }
  if (anyWrites && JSON.stringify(nowFailed) !== JSON.stringify(prevFailed)) {
    if (Object.keys(nowFailed).length) await env.SYNC_STATE.put(failKey, JSON.stringify(nowFailed));
    else await env.SYNC_STATE.delete(failKey);
  }
  for (const d of deletes) {
    if (failedDeletes.has(d.row.id)) continue; // only what was actually removed
    logEvent(events, { account: acct.nickname, action: "pending_retire", transaction_id: d.row.id, import_id: d.row.import_id || undefined, amount: Number(d.row.amount || 0), detail: `${d.row.payee_name || ""}: ${d.reason}` });
  }
  for (const id of rejected) {
    logEvent(events, { account: acct.nickname, action: "import_id_rejected", import_id: id, detail: "YNAB already has (or previously deleted) this import id; row not created" });
  }
  // Too old to check for duplicates: logged for review once, not created.
  const tooOldKey = `too_old_logged:${pid}`;
  if (tooOld.length > 0) {
    const logged: Record<string, string> = await readJson(env, tooOldKey, {});
    let changed = false;
    for (const it of tooOld) {
      if (logged[it.t.transaction_id]) continue;
      logged[it.t.transaction_id] = today; changed = true;
      logEvent(events, { account: acct.nickname, action: "too_old_to_import", transaction_id: it.t.transaction_id, amount: it.spec.row!.amount, detail: `${safePayee(it.t)} ${it.t.date}: older than ${IDENTITY_HORIZON_DAYS - SNAPSHOT_MARGIN_DAYS} days, so it can't be checked against YNAB for a duplicate. Not imported; add it by hand if it's missing.` });
    }
    if (changed) await env.SYNC_STATE.put(tooOldKey, JSON.stringify(logged));
  }

  // Persist state only when it changed.
  const survivingIds = new Set(snapshot.filter(r => !deleteIds.has(r.id) || failedDeletes.has(r.id)).map(r => r.id));
  const mergedLinks: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...links, ...newLinks })) if (survivingIds.has(v)) mergedLinks[k] = v;
  if (!options.backfillOnly && cursor !== cursorAtStart) await env.SYNC_STATE.put(cursorKey, cursor);
  if (JSON.stringify(mergedLinks) !== linksJsonAtStart) await env.SYNC_STATE.put(linksKey, JSON.stringify(mergedLinks));
  await persistPostedMap();
  if (legCacheChanged) await env.SYNC_STATE.put(legCacheKey, JSON.stringify(legCache));
  if (Object.keys(legacyPendingMap).length > 0) await env.SYNC_STATE.delete(pendingKey); // superseded by derived ids + links

  const partial = updatedResult.failed.length > 0 || deleteErrors.length > 0;
  return {
    // "partial": everything else was written, but some updates or removals weren't.
    status: partial ? "partial" : "ok",
    partial_note: partial ? `${updatedResult.failed.length} update(s) and ${deleteErrors.length} removal(s) didn't go through; see Activity.` : undefined,
    ...summaryBase,
    created_count: createdResult.added || 0,
    updated_count: updatedResult.updated,
    update_errors: updatedResult.failed,
    deleted_count: deleted,
    delete_errors: deleteErrors,
    too_old_count: tooOld.length,
    rejected_import_ids: rejected,
    pending_imported_count: creates.filter(c => c.cleared === "uncleared").length,
    pending_retired_count: deleted,
    plan,
    recent_imports: plan.creates.slice(0, 30),
    created_ids: createdResult.created_ids || [],
    ynab: { added: createdResult.added || 0, updated: updatedResult.updated, deleted }
  };
}

// How a row was matched, in words, for Activity.
export const VIA_WORDS: Record<string, string> = {
  owned: "", posted_flip_exact: "its pending row", posted_flip_drift: "its pending row, amount adjusted",
  content: "matched by name", content_amount: "matched by amount", transfer_leg: "transfer from your other account",
  race_non_worker: "", posted_at_bank: "your row, now posted at the bank", payment_posted_at_bank: "payment posted at the bank",
  card_leg: "payment to this card"
};

// Read-only representation map for the audit and reconcile views: which YNAB row, if
// any, represents each Plaid charge. Same ownership rules as the sync, then a
// one-to-one content fallback, so the views can never disagree with the engine.
export async function representPlaid(
  env: Env, acct: AccountConfig, plaid: PlaidTransaction[], register: YNABExistingTransaction[],
  ctx: RoutingContext, skipRules: SkipRule[]
): Promise<{ rowByTx: Map<string, YNABExistingTransaction>; specByTx: Map<string, DesiredSpec> }> {
  const pid = acct.plaid_account_id;
  const epoch = isCreditCardAccount(acct) ? await getCcEpoch(env, pid) : "";
  const links = await readJson(env, `${LINKS_KV_PREFIX}${pid}`, {});
  const postedMap = await readJson(env, `posted:${pid}`, {});
  const legacy = await readJson(env, `pending:${pid}`, {});
  const own = buildOwnership(acct, register, links, postedMap, legacy, plaid, epoch);
  const rowByTx = new Map<string, YNABExistingTransaction>();
  const specByTx = new Map<string, DesiredSpec>();
  const claimed = new Set<string>();
  const ordered = [...plaid].sort((a, b) => (a.date < b.date ? -1 : 1));
  const liveKeys = new Set<string>();
  for (const t of plaid) { liveKeys.add(lifecycleKey(t)); liveKeys.add("tx:" + t.transaction_id); if (t.pending_transaction_id) liveKeys.add(t.pending_transaction_id); }
  for (const t of ordered) specByTx.set(t.transaction_id, desiredForPlaid(t, acct, skipRules, ctx));
  for (const t of ordered) {
    const r = own.rowFor(t);
    if (r && !claimed.has(r.id)) { claimed.add(r.id); rowByTx.set(t.transaction_id, r); }
  }
  // Money in from another of your accounts: the booked transfer's leg (as the engine).
  const inflows = ordered.filter(t => t.amount < 0 && !!specByTx.get(t.transaction_id)?.row)
    .sort((a, b) => Number(!specByTx.get(a.transaction_id)!.transferFrom) - Number(!specByTx.get(b.transaction_id)!.transferFrom));
  for (const t of inflows) {
    if (rowByTx.has(t.transaction_id)) continue;
    const leg = transferLegFor(t, specByTx.get(t.transaction_id)!, acct, register, r => !claimed.has(r.id) && !own.isOwnedByOther(r, t), ctx,
      inflows.filter(o => o !== t && !rowByTx.has(o.transaction_id) && !specByTx.get(o.transaction_id)!.transferFrom));
    if (leg) { claimed.add(leg.id); rowByTx.set(t.transaction_id, leg); }
  }
  const diRow = (r: YNABExistingTransaction) => String(r.import_id || "").startsWith("YNAB:") && !isWorkerImportPrefix(r.import_id) && !Object.values(postedMap).includes(String(r.import_id));
  const diCands = ordered.filter(t => !rowByTx.has(t.transaction_id) && !specByTx.get(t.transaction_id)?.skip && !!specByTx.get(t.transaction_id)?.row && !specByTx.get(t.transaction_id)?.row?.payee_id).map(t => ({ t }));
  for (const [{ t }, r] of directImportPairs(diCands, register, (r, i) => !claimed.has(r.id) && !isWorkerPendingRow(r) && !own.isOwnedByOther(r, i.t) && !(i.t.pending && r.cleared !== "uncleared"), diRow)) {
    if (claimed.has(r.id) || rowByTx.has(t.transaction_id)) continue;
    claimed.add(r.id); rowByTx.set(t.transaction_id, r);
  }
  for (const strength of ["strong", "leading_word"] as const) {
    for (const t of [...ordered.filter(x => !x.pending), ...ordered.filter(x => x.pending)]) {
      if (rowByTx.has(t.transaction_id)) continue;
      const m = contentMatch(t, specByTx.get(t.transaction_id)!, register, r => !claimed.has(r.id) && !own.isOwnedByOther(r, t) && !(t.pending && diRow(r) && r.cleared !== "uncleared"), ctx.aliases, strength);
      if (m) { claimed.add(m.id); rowByTx.set(t.transaction_id, m); }
    }
  }
  const leftovers = ordered.filter(t => {
    const spec = specByTx.get(t.transaction_id);
    // Card-side payments are skipped for import but still need their transfer found.
    return !rowByTx.has(t.transaction_id) && (!spec?.skip || isInSideKind(spec.skipKind)) && !spec?.row?.payee_id;
  }).map(t => ({ t, inSide: isInSideKind(specByTx.get(t.transaction_id)?.skipKind) }));
  for (const [{ t }, r] of uniqueAmountPairs(leftovers.filter(l => !rowByTx.has(l.t.transaction_id)), register, (r, i) => !claimed.has(r.id) && !isWorkerPendingRow(r) && !own.isOwnedByOther(r, i.t), ctx.aliases, diRow)) {
    if (claimed.has(r.id)) continue;
    claimed.add(r.id); rowByTx.set(t.transaction_id, r);
  }
  // A posted charge whose worker pending row has not flipped yet (next sync will) is
  // still represented: exact amount, within 4 days, unclaimed worker pending row.
  for (const t of ordered) {
    if (rowByTx.has(t.transaction_id) || t.pending) continue;
    const milli = Math.round(-t.amount * 1000);
    // (Also a pending row you marked cleared yourself whose old pending charge is gone.)
    const m = register.find(r => !claimed.has(r.id) && isWorkerPendingOrigin(r) && Number(r.amount) === milli && daysApart(r.date, t.date) <= 4 &&
      (isWorkerPendingRow(r) || !liveKeys.has(own.ownerOf.get(r.id) || "")));
    if (m) { claimed.add(m.id); rowByTx.set(t.transaction_id, m); }
  }
  return { rowByTx, specByTx };
}

// Bootstrap: move the cursor to "now" without importing history (the YNAB starting
// balance already reflects it), then run the engine once to import what is pending
// right now. Idempotent: existing rows are found by ownership or content.
// Where YNAB's coverage of this account ends. An account that was kept up by Direct
// Import (or by the worker before sync was turned off) has imported, posted rows;
// the newest one's date is where that coverage stops. Posted charges from a few days
// before it are imported at bootstrap (each checked against YNAB first, so what's
// already there is matched, not duplicated), so nothing falls in the gap between the
// last import and the switch. A brand-new YNAB account (starting balance only)
// starts from today.
export async function bootstrapPlan(env: Env, acct: AccountConfig): Promise<{ floor: string; today: string; catchUp: boolean; backfillDays?: number }> {
  const today = todayInTimeZone(env);
  let floor = today;
  try {
    const since = toIsoDate(new Date(Date.now() - VERIFY_WINDOW_DAYS * 86400000));
    const reg = await ynabGetAccountTransactions(env, acct.ynab_account_id, since);
    const latest = reg.filter(r => !!r.import_id && r.cleared !== "uncleared" && r.date <= today).map(r => r.date).sort().pop();
    // A few days earlier than that: a charge made before Direct Import's last run can
    // post after it (Amex dates charges by when you made them).
    if (latest) {
      const back = toIsoDate(new Date(Date.parse(`${latest}T00:00:00Z`) - BOOTSTRAP_OVERLAP_DAYS * 86400000));
      if (back < today) floor = back;
    }
  } catch { /* can't read YNAB: start from today */ }
  const catchUp = floor < today;
  return { floor, today, catchUp, backfillDays: catchUp ? Math.min(VERIFY_WINDOW_DAYS, calendarDaysBetween(floor, today) + 2) : undefined };
}

export async function bootstrap(env: Env, nickname: string, runId?: string, force = false): Promise<any> {
  const accounts = await getAccounts(env);
  const acct = accounts.find(a => a.nickname === nickname);
  if (!acct) return { ok: false, error: `no account named '${nickname}'` };
  // Bootstrapping moves the bank position to "now", so anything that hasn't synced yet
  // would be skipped for good. Refuse on an account that is already set up.
  if (!force && (await env.SYNC_STATE.get(`bootstrapped:${acct.plaid_account_id}`)) === "1") {
    return { ok: false, error: `${nickname} is already set up. Bootstrapping again would skip any charge that hasn't synced yet. Add &force=true only if you really mean to start over.` };
  }

  let cursor = "";
  let hasMore = true;
  while (hasMore) {
    const resp = await plaidCall(env, "/transactions/sync", { access_token: acct.plaid_access_token, cursor, count: 500 });
    cursor = resp.next_cursor;
    hasMore = resp.has_more;
  }
  await env.SYNC_STATE.put(`cursor:${acct.plaid_account_id}`, cursor);

  const { floor, catchUp, backfillDays } = await bootstrapPlan(env, acct);
  // A brand-new YNAB account: its starting balance is the bank's posted balance right
  // now, which already includes anything posted today. So posted charges are only
  // created from TOMORROW's date on (later changes still come through the bank feed
  // as they happen). With a catch-up, the floor itself is where YNAB's coverage ends.
  const storedFloor = catchUp ? floor : toIsoDate(new Date(Date.parse(`${floor}T00:00:00Z`) + 86400000));
  await env.SYNC_STATE.put(`bootstrap_date:${acct.plaid_account_id}`, storedFloor);

  const skipRules = await getSkipRules(env);
  const settings = settingForAccount(await getAccountAutomationSettings(env), acct);
  const result = await syncAccountEngine(env, acct, skipRules, { backfillOnly: true, windowImport: catchUp ? "all" : "pending", backfillDays, accountSetting: settings, trigger: "bootstrap", runId });
  await env.SYNC_STATE.put(`bootstrapped:${acct.plaid_account_id}`, "1");

  return {
    status: "bootstrapped",
    account: nickname,
    pending_imported: result.pending_imported_count,
    caught_up_from: catchUp ? floor : null,
    result,
    note: catchUp
      ? `YNAB already had this account's charges through ${floor}. Pending charges, and posted charges from ${floor} on that weren't in YNAB yet, were imported; everything already there was matched, not duplicated.`
      : "Set your YNAB starting balance to match this account's current posted balance at the bank; pending charges were imported separately."
  };
}
