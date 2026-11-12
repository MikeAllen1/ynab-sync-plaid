import { TransferLabel } from "../rules/transfer-labels";
import { isCreditCardAccount } from "../store/accounts";
import { cleanName } from "./matching";
import { AccountAutomationSetting, AccountConfig, PlaidTransaction, YNABExistingTransaction } from "../types";

// Classify a checking-account money movement into how the worker should import it,
// now that the worker (not Direct Import) owns checking. Three real cases for this
// user, decided from Plaid's personal_finance_category (reliable) + name fallback:
//   "card_payment"   LOAN_PAYMENTS / card-payment text -> checking->card transfer
//   "spendable_in"   TRANSFER_IN that is real money in (Zelle from spouse, deposits)
//                    -> normal inflow to Ready to Assign (it's spendable)
//   "outflow_track"  TRANSFER_OUT to external accounts (e.g. savings elsewhere) -> normal
//                    outflow with a clean payee so YNAB auto-categorizes it
//   null             not a transfer; handle as an ordinary purchase
export const CARD_ISSUER_RE = /\b(AMERICAN EXPRESS|AMEX|CHASE CREDIT|CAPITAL ONE|DISCOVER (?:CARD|BANK|E-?PAYMENT)|CITI ?CARD|CITIBANK|BARCLAYCARD|BARCLAYS|SYNCHRONY|BK OF AMER|BANK OF AMERICA CARD|WELLS FARGO CARD|US BANK CARD|APPLECARD|APPLE CARD|GSBANK)\b/;
export const CARD_PAYMENT_WORDS_RE = /\b(ACH PMT|E-?PAYMENT|EPAY|AUTO ?PAY|AUTOPAY|ONLINE PMT|CRCARDPMT|CARD PMT|PAYMENT|PMT)\b/;

export function classifyTransfer(t: PlaidTransaction): "card_payment" | "spendable_in" | "outflow_track" | null {
  const primary = (t.pfc_primary || "").toUpperCase();
  const detailed = (t.pfc_detailed || "").toUpperCase();
  const text = [t.name, t.merchant_name].filter(Boolean).join(" ").toUpperCase();

  // CARD PAYMENT — must be specifically a CREDIT CARD payment, NOT any loan payment.
  // Plaid's primary "LOAN_PAYMENTS" covers mortgages, auto loans, and student loans
  // too, so keying off primary alone wrongly turned a mortgage payment into a
  // transfer to the credit card. Match only the credit-card detailed category, the
  // card-side "Payment Thank You" disbursement, or a name that clearly names the
  // credit card. A mortgage/auto/student payment falls through to outflow_track
  // (tracked spending) instead.
  const isMortgageOrOtherLoan =
    detailed.includes("MORTGAGE") || detailed.includes("CAR_PAYMENT") ||
    detailed.includes("STUDENT") || detailed.includes("PERSONAL_LOAN") ||
    /\b(MORTGAGE|FREEDOM MTG|FREEDOM MORTGAGE|LOANCARE|MR COOPER|ROCKET|WELLS FARGO HOME|CALIBER|CARRINGTON)\b/.test(text);
  if (!isMortgageOrOtherLoan) {
    if (detailed.includes("CREDIT_CARD_PAYMENT")) return "card_payment";
    // A card issuer's name plus a payment descriptor is a card payment whatever
    // category Plaid guessed (Chase's raw ACH text "ORIG CO NAME:AMERICAN EXPRESS CO
    // ENTRY DESCR:ACH PMT", another bank's "AMEX EPAYMENT ACH PMT"). An issuer name alone is
    // not enough: that could be a purchase.
    if (CARD_ISSUER_RE.test(text) && CARD_PAYMENT_WORDS_RE.test(text)) return "card_payment";
    if (primary === "LOAN_DISBURSEMENTS") return "card_payment"; // card-side "Payment Thank You"
    // Name fallback, only when Plaid's category doesn't already say what this is
    // (no category, or a transfer / loan category). A purchase Plaid categorized as
    // shopping, food, entertainment and so on is never re-read as a card payment by
    // its name. Whole words only: CARDONA and CARDINAL are not CARD.
    const categoryAllowsName = !primary || primary.startsWith("TRANSFER") || primary.startsWith("LOAN");
    if (categoryAllowsName && (
        /PAYMENT[\s-]*THANK YOU/.test(text) ||
        /\bCHASE CREDIT (CRD|CARD)\b/.test(text) ||
        (/\bPAYMENTS?\b/.test(text) && /\b(CHASE|CARD)\b/.test(text)))) {
      return "card_payment";
    }
  }

  // Incoming money -> Ready to Assign (payroll, spouse Zelle, savings->checking,
  // PayPal refunds/credits). On this account inflow is a NEGATIVE Plaid amount.
  if (primary === "TRANSFER_IN" || primary === "INCOME") {
    return "spendable_in";
  }

  // PayPal PURCHASES are spending, not an account transfer. Plaid tags them
  // TRANSFER_OUT_TRANSFER_OUT_FROM_APPS but they're really "I bought something and
  // paid with PayPal." Route to outflow_track so it's a normal categorizable expense
  // (transferPayeeName gives it a "PayPal" payee, not a transfer label).
  if (detailed === "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS" && t.amount > 0) {
    return "outflow_track";
  }

  // Outgoing transfer (savings sweep, money to another of your accounts) or a non-card loan
  // payment (mortgage/auto). All tracked spending; transferPayeeName distinguishes
  // savings vs your other accounts vs loan by name so they don't all read the same.
  if (primary === "TRANSFER_OUT" || (primary === "LOAN_PAYMENTS" && t.amount > 0)) {
    return "outflow_track";
  }

  return null;
}

// A clean, STABLE payee for a transfer so YNAB can build an auto-categorize rule.
// The raw Plaid name carries transaction numbers that change every time, which is
// exactly why YNAB never learned a rule before. We map to a fixed destination label.
// Your own accounts at other banks can be named by their last digits (dashboard ->
// Transfer labels, KV "transfer_labels"): "...1234" -> "Savings". PayPal purchases are
// their own thing; an unknown transfer gets a neutral label.
// Brokerages and investing apps get their own payee, in both directions (Robinhood
// pulling money to invest, or sending it back), so YNAB can remember a category for
// them instead of lumping them into "Transfer Out" / "Transfer In".
export const BROKERAGE_PAYEES: Array<[RegExp, string]> = [
  [/\bROBINHOOD\b/, "Robinhood"], [/\bFIDELITY\b/, "Fidelity"], [/\bVANGUARD\b/, "Vanguard"],
  [/\bSCHWAB\b/, "Charles Schwab"], [/\bE\*?TRADE\b/, "E*TRADE"], [/\bCOINBASE\b/, "Coinbase"],
  [/\bACORNS\b/, "Acorns"], [/\bBETTERMENT\b/, "Betterment"], [/\bWEALTHFRONT\b/, "Wealthfront"],
  [/\bM1 ?FINANCE\b/, "M1 Finance"], [/\bWEBULL\b/, "Webull"], [/\bSTASH\b/, "Stash"]
];
// The person's first and last name after "TO"/"FROM" in a Zelle descriptor, title
// cased: "Zelle payment to JOHN SMITH JPM99A1" -> "John Smith". A middle initial is
// skipped; a token with digits (a reference code) ends the name.
export function zellePersonName(text: string, dir: "TO" | "FROM"): string {
  const m = new RegExp(`\\b${dir}\\s+(.+)$`, "i").exec(text);
  if (!m) return "";
  const words: string[] = [];
  const tokens = m[1].trim().split(/\s+/);
  for (let i = 0; i < tokens.length && words.length < 2; i++) {
    const w = tokens[i].replace(/[.,]$/, "");
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(w)) break;
    if (w.length === 1 && i + 1 < tokens.length && /^[A-Za-z][A-Za-z'-]+[.,]?$/.test(tokens[i + 1])) continue; // middle initial
    words.push(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  return words.join(" ");
}

export function transferPayeeName(t: PlaidTransaction, kind: "spendable_in" | "outflow_track", labels: TransferLabel[] = []): string {
  const text = `${t.name} ${t.merchant_name || ""}`;
  const upper = text.toUpperCase();
  const detailed = (t.pfc_detailed || "").toUpperCase();
  for (const [re, name] of BROKERAGE_PAYEES) if (re.test(upper)) return name;
  // Payment apps get their own payee too, so YNAB can learn a category for them.
  if (kind === "outflow_track" && /ZELLE/.test(upper)) {
    const name = zellePersonName(text, "TO");
    return name ? `Zelle to ${name}` : "Zelle Payment";
  }
  if (/\bVENMO\b/.test(upper)) return "Venmo";
  if (/\bCASH ?APP\b|\bSQUARE CASH\b|\bSQC\*/.test(upper)) return "Cash App";
  if (/\bAPPLE CASH\b/.test(upper)) return "Apple Cash";
  // Another investment account Plaid recognizes as one: its own name, not a generic label.
  if (detailed.includes("INVESTMENT") && (t.merchant_name || cleanName(t.name || ""))) return String(t.merchant_name || cleanName(t.name || "")).slice(0, 100);
  // Match an account tail whether written "...1234" or "XXXXXX1234" or "Account 1234".
  const tailMatch = text.match(/(?:\.{2,}|X{2,}|ACCOUNT\s+)(\d{3,4})/i);
  const tail = tailMatch ? tailMatch[1] : "";
  const label = tail ? labels.find(l => l.tail === tail) : undefined;

  if (kind === "outflow_track") {
    // One of your own named accounts.
    if (label) return label.out || label.label;
    // Non-card loan payments first (mortgage/auto), by category.
    if (detailed.includes("MORTGAGE") || /MORTGAGE|MTG/.test(upper)) return "Mortgage Payment";
    // PayPal purchases: spending routed via PayPal, not an account transfer.
    if (detailed === "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS" || /PAYPAL/.test(upper)) return "PayPal";
    // Savings sweep (explicit category or wording).
    if (detailed === "TRANSFER_OUT_SAVINGS" || /SAVINGS/.test(upper)) return "Savings";
    if ((t.pfc_primary || "").toUpperCase() === "LOAN_PAYMENTS") return "Loan Payment";
    // Unknown outgoing transfer: a neutral, stable label — never guess which account.
    return "Transfer Out";
  }
  // spendable_in
  if (/ZELLE/i.test(text)) {
    const name = zellePersonName(text, "FROM");
    return name ? `Zelle from ${name}` : "Zelle Payment";
  }
  if (label) return label.in || `Transfer from ${label.label}`;
  if (/SAVINGS/.test(upper)) return "Transfer from Savings";
  if (/PAYPAL/.test(upper)) return "PayPal";
  if (/PAYROLL|SALARY|DIRECT DEP/.test(upper)) return "Payroll";
  return "Transfer In";
}

// ---- Multi-card payment routing ----
// Each tracked credit card says how a checking-side payment names it: last-4 digits
// and/or words. The rule lives on the card's account record (Settings) so a new card
// routes without a code change. Cards added before that setting existed fall back to
// the built-in rule for their nickname. A payment that names no tracked, sync-enabled
// card stays a plain outflow.
// Built-in rules by nickname (none): set each card's rule on the dashboard instead.
export const BUILTIN_PAYMENT_MATCH: Record<string, { last4: string[]; words: string[] }> = {};

export function builtinPaymentMatch(nickname: string): { last4: string[]; words: string[] } | undefined {
  return BUILTIN_PAYMENT_MATCH[String(nickname || "").toLowerCase()];
}

export function paymentMatchFor(acct: AccountConfig): { last4: string[]; words: string[] } | undefined {
  return acct.payment_match || builtinPaymentMatch(acct.nickname);
}

export function paymentTextMatches(t: PlaidTransaction, last4: string[], words: string[]): boolean {
  const text = ((t.name || "") + " " + (t.merchant_name || "")).toLowerCase();
  // Last 4 as its own number: "AUTOPAY 1234" names the card, a trace number such as
  // 021000012341234 that merely contains the digits does not.
  return last4.some(l => l && new RegExp(`(^|[^0-9])${l}([^0-9]|$)`).test(text)) || words.some(w => w && text.includes(w.toLowerCase()));
}

// "card ending in 4455", "XXXX4455", "...4455": the last 4 of a specific account.
export const ACCOUNT_REF_RE = /(?:\.{2,}|x{2,}|\*+|\bacct\.?\s*#?\s*|\baccount\s*#?\s*|\bending(?:\s+in)?\s*|\bx)\s*(\d{4})(?![0-9])/gi;
export function accountRefsIn(t: PlaidTransaction): string[] {
  const text = (t.name || "") + " " + (t.merchant_name || "");
  return [...text.matchAll(ACCOUNT_REF_RE)].map(m => m[1]);
}

export function untrackedCardPayee(t: PlaidTransaction): string {
  const text = ((t.name || "") + " " + (t.merchant_name || "")).toUpperCase();
  if (text.includes("AMERICAN EXPRESS") || text.includes("AMEX")) return "American Express";
  if (t.merchant_name) return t.merchant_name;
  return "Credit Card Payment";
}

// Which credit-card account a checking-side payment names, if any: a credit card in
// the map whose payment rule matches the payment text. The card's own sync switch
// doesn't matter here: it says whether the worker imports that card's charges, but a
// payment from checking is still a transfer into it. On a Direct Import card (Amex),
// Direct Import then matches its "Payment Thank You" to the transfer's card side.
export function resolveCardForPayment(
  t: PlaidTransaction,
  accounts: AccountConfig[],
  _settings: AccountAutomationSetting[]
): AccountConfig | null {
  // Every card whose rule matches. When more than one does (an Amex payment whose
  // ID happens to read "1234"), the card named by WORDS ("american express") wins over
  // one matched only by a number, since a number can appear by coincidence.
  const matches = accounts.filter(a => {
    if (!isCreditCardAccount(a)) return false;
    const rule = paymentMatchFor(a);
    return !!rule && paymentTextMatches(t, rule.last4, rule.words);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const byWords = matches.filter(a => { const r = paymentMatchFor(a)!; return paymentTextMatches(t, [], r.words); });
    if (byWords.length === 1) return byWords[0];
    // Multiple matching cards without a unique word or account-reference match
    // are ambiguous. Never route a payment to whichever account happens to appear
    // first in configuration.
    const refs = new Set(accountRefsIn(t));
    const byRef = matches.filter(a => (paymentMatchFor(a)!.last4 || []).some(l => refs.has(l)));
    return byRef.length === 1 ? byRef[0] : null;
  }
  // No card named directly ("CHASE CREDIT CRD EPAY" carries no last 4): if the text
  // names the issuer and exactly one mapped card is from that issuer, it's that card.
  // Not when the text names a specific card number that isn't one of yours ("Payment
  // to Chase card ending in 4455" is a different Chase card).
  const known = new Set(accounts.filter(isCreditCardAccount).flatMap(a => paymentMatchFor(a)?.last4 || []));
  if (accountRefsIn(t).some(d => !known.has(d))) return null;
  const text = ((t.name || "") + " " + (t.merchant_name || "")).toUpperCase();
  const issuers: Array<[RegExp, RegExp]> = [
    [/\bCHASE\b/, /chase/i], [/\b(AMEX|AMERICAN EXPRESS)\b/, /amex|american express/i], [/\bCAPITAL ONE\b/, /capital one/i],
    [/\bDISCOVER\b/, /discover/i], [/\bCITI/, /citi/i], [/\bBARCLAY/, /barclay/i], [/\bSYNCHRONY\b/, /synchrony/i]
  ];
  for (const [inText, inInstitution] of issuers) {
    if (!inText.test(text)) continue;
    const cards = accounts.filter(a => isCreditCardAccount(a) && (inInstitution.test(a.institution || "") || inInstitution.test(a.nickname)));
    if (cards.length === 1) return cards[0];
  }
  return null;
}

export function summarizeYnabExisting(t: YNABExistingTransaction): any {
  return {
    id: t.id,
    date: t.date,
    payee_name: t.payee_name || null,
    amount: roundMoney(Number(t.amount || 0) / 1000),
    cleared: t.cleared || null,
    approved: !!t.approved,
    memo: t.memo || null,
    payee_id: t.payee_id || null,
    transfer_transaction_id: t.transfer_transaction_id || null,
    import_id: t.import_id || null
  };
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
