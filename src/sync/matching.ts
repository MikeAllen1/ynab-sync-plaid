import { PayeeAlias, applyPayeeAlias } from "../rules/payee-aliases";
import { roundMoney } from "./transfers";
import { Env, PlaidTransaction, YNABExistingTransaction } from "../types";
import { safePayee } from "../util/errors";

// ---------- Plaid <-> YNAB conversion ----------

export function cleanName(raw: string): string {
  // Chase ACH text: "ORIG CO NAME:CITY UTILITIES ENTRY DESCR:... SEC:WEB ..." -> the
  // company name.
  const orig = /ORIG CO NAME:\s*(.+?)\s+CO ENTRY DESCR:/i.exec(raw || "");
  if (orig) raw = orig[1];
  let s = raw
    .replace(/\b\d{6,}\b/g, "")
    .replace(/TRANSACTION#?:?\s*/gi, "")
    .replace(/\s+\d{2}\/\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (s === s.toUpperCase() && s.length > 3) {
    s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  return s.slice(0, 50);
}

// ---------- Import IDs + content matching ----------
//
// Pending rows (checking)  wpend:<hash of Plaid pending id>     worker-owned
// Card rows                pcc:<epoch>:<hash> / pcp:<epoch>:<hash>
// Posted rows (checking)   YNAB:<milliunits>:<date>:<occurrence>, pinned per Plaid id
//                          in postedMap. This is YNAB's own format, so if Direct
//                          Import later imports the same charge, YNAB dedupes it.
// A pending row never carries the posted id, so it can't suppress Direct Import's
// real posted charge.

export const WORKER_PENDING_PREFIX = "wpend:";

// Content-fallback tuning (see contentMatch). Loosen NAME_SIMILARITY_MIN if a manual
// entry is not recognized; tighten it if unrelated charges ever pair up.
export const ALREADY_IN_YNAB_DATE_DAYS = 4;     // skip-filter date window (exact amount)
export const CARD_PAYMENT_POSTING_DAYS = 7;     // card credits an external-bank payment up to ~5 business days later
export const NAME_SIMILARITY_MIN = 0.5;          // token-overlap threshold for "similar name"

export function ynabImportId(milliunits: number, date: string, occurrence: number): string {
  return `YNAB:${milliunits}:${date}:${occurrence}`;
}

// The current epoch for a card account (defaults to "1"). Bumped by /reset-card.
export async function getCcEpoch(env: Env, plaidAccountId: string): Promise<string> {
  return (await env.SYNC_STATE.get(`cc_epoch:${plaidAccountId}`)) || "1";
}

// Deterministic short hash (FNV-1a, base36) of a string. Stable across runs and
// isolates, so the same Plaid transaction_id always maps to the same import_id.
// Returns up to ~26 chars worst case; with the 6-char prefix that stays < 36.
export function shortStableHash(input: string): string {
  const str = String(input || "");
  // Two independent FNV-1a passes (different offsets) widen the space to ~64 bits
  // so collisions between distinct pending transactions are effectively impossible
  // within a single account's live pending set.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}


// Seed occurrence counts per (milliunit amount, date) from the existing register so
// new ids continue YNAB's own numbering instead of restarting at :1 and colliding.
export function seedOccurrenceCounts(existing: YNABExistingTransaction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of existing) {
    const key = `${Number(t.amount || 0)}:${t.date}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function nextOccurrence(counts: Record<string, number>, milliunits: number, date: string): number {
  const key = `${milliunits}:${date}`;
  counts[key] = (counts[key] || 0) + 1;
  return counts[key];
}

// Keep postedMap bounded. Each value is a YNAB-format id "YNAB:<milli>:<date>:<occ>",
// so we can read the charge date straight out of it. Pins are kept for the identity
// horizon (IDENTITY_HORIZON_DAYS), the oldest date the engine will ever create a row
// for; older ones can be dropped.
export function prunePostedMap(map: Record<string, string>, oldestDate: string): Record<string, string> {
  const cutoff = Date.parse(`${oldestDate}T00:00:00Z`);
  if (!Number.isFinite(cutoff)) return map;
  const out: Record<string, string> = {};
  for (const [txId, importId] of Object.entries(map)) {
    const parts = String(importId).split(":"); // YNAB : milli : date : occ
    const d = parts.length >= 4 ? Date.parse(`${parts[2]}T00:00:00Z`) : NaN;
    if (!Number.isFinite(d) || d >= cutoff) out[txId] = importId;
  }
  return out;
}

export function normalizeMerchant(s: string): string {
  return String(s || "").toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    // Wallet prefixes Amex and others put in front of the merchant ("APLPAY CARIBOU
    // COFFE..."), and Amazon's abbreviation.
    .replace(/\b(APLPAY|APPLE PAY|APPLEPAY|GPAY|GOOGLE PAY)\b/g, " ")
    .replace(/\bAMZN\b/g, "AMAZON")
    .replace(/\b(LLC|INC|CO|THE|SQ|TST|POS|PURCHASE|PAYMENT|DEBIT|CARD|VISA|DDA)\b/g, " ")
    .replace(/\d{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function namesSimilar(a: string, b: string, aliases: PayeeAlias[]): boolean {
  if (!a || !b) return false;
  // Canonicalize through payee aliases first, so different source names for the
  // same merchant (e.g. an old brand name on the bank side vs the new one in YNAB) match.
  a = applyPayeeAlias(a, aliases);
  b = applyPayeeAlias(b, aliases);
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // Same letters, different spacing: "LUNDS BYERLYS" vs "LUNDSBYERLYS CH".
  const ca = a.replace(/ /g, ""), cb = b.replace(/ /g, "");
  if (ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca))) return true;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= NAME_SIMILARITY_MIN;
}

// Weaker than namesSimilar: both names start with the same distinctive word, e.g. a
// bank descriptor truncated mid-name ("EASTVIEW LIGH" vs "EASTVIEW LGHTNING ...").
// Only used after every strong name match has been made.
export function leadingWordMatch(a: string, b: string, aliases: PayeeAlias[]): boolean {
  const fa = applyPayeeAlias(a, aliases).split(" ").filter(Boolean)[0] || "";
  const fb = applyPayeeAlias(b, aliases).split(" ").filter(Boolean)[0] || "";
  return fa.length >= 4 && fa === fb && !/^\d+$/.test(fa);
}

// Two names that clearly name different merchants: each has a real word (4+ letters,
// no digits) and they share none. "WALMART" vs "TARGET" conflict; "2ST PAUL SAINT ST
// PAUL" vs "2PSC" do not (2PSC is an abbreviation, not a contradicting word).
// A balance gap that exactly equals what posted at the bank in the last 2 days (one
// charge, or all of them together). Banks (Chase especially) often list a charge as
// posted before their balance counts it; the balance catches up overnight. Returns
// the explanation in words, or null. diff is YNAB minus bank, in YNAB's sign.
export const BALANCE_LAG_DAYS = 2;
export function bankBalanceLag(diff: number, plaid: PlaidTransaction[], today: string): string | null {
  if (Math.abs(diff) <= 0.01) return null;
  const recent = plaid.filter(t => !t.pending && daysApart(t.date, today) <= BALANCE_LAG_DAYS);
  const ynabAmt = (t: PlaidTransaction) => roundMoney(-Number(t.amount || 0));
  const words = (ts: PlaidTransaction[]) => ts.map(t => `${safePayee(t)} $${Math.abs(ynabAmt(t)).toFixed(2)} (${t.date})`).join(", ");
  const tail = "posted at the bank in the last 2 days. The bank's balance often doesn't count a new charge until its overnight update, so this usually goes away by the next morning. Check again then before adjusting anything in YNAB.";
  const one = recent.filter(t => Math.abs(ynabAmt(t) - diff) <= 0.01);
  if (one.length) return `The difference equals ${words([one[0]])}, which ${tail}`;
  if (recent.length > 1 && Math.abs(roundMoney(recent.reduce((s, t) => s + ynabAmt(t), 0)) - diff) <= 0.01) return `The difference equals everything that ${tail.replace(/^posted at the bank in the last 2 days\./, `posted at the bank in the last 2 days (${words(recent)}).`)}`;
  return null;
}

// Does this name carry a word the conflict check can compare (4+ letters)? "Gas",
// "QT 123" or an empty payee don't, so they can neither confirm nor rule out a match.
export function hasComparableName(x: string, aliases: PayeeAlias[]): boolean {
  return applyPayeeAlias(x, aliases).split(" ").some(w => /^[A-Z]{4,}$/.test(w));
}

// Amount-only pairings whose names say nothing either way must be this close in date.
// Wider than this, a same-amount purchase days apart ("Gas $40" Monday, "SHELL OIL
// $40" Thursday) is as likely a different purchase as the same one.
export const AMOUNT_ONLY_UNNAMED_DATE_DAYS = 1;

export function namesConflict(a: string, b: string, aliases: PayeeAlias[]): boolean {
  const words = (x: string) => new Set(applyPayeeAlias(x, aliases).split(" ").filter(w => /^[A-Z]{4,}$/.test(w)));
  const wa = words(a), wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  for (const w of wa) if (wb.has(w)) return false;
  // Banks abbreviate: "INTL" is INTERNATIONAL, "AMZN" is AMAZON. A word
  // whose letters appear in order in the other name, starting at the start of one of
  // its words, is an abbreviation of it, not a different merchant.
  const abbrevOf = (short: string, other: Set<string>) => {
    const ws = [...other];
    for (let i = 0; i < ws.length; i++) {
      if (ws[i][0] !== short[0]) continue;
      const rest = ws.slice(i).join("");
      let k = 0;
      for (const ch of rest) { if (ch === short[k]) k++; if (k === short.length) return true; }
    }
    return false;
  };
  for (const w of wa) if (abbrevOf(w, wb)) return false;
  for (const w of wb) if (abbrevOf(w, wa)) return false;
  return true;
}

export function daysApart(a?: string, b?: string): number {
  const da = Date.parse(`${a || ""}T00:00:00Z`);
  const db = Date.parse(`${b || ""}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
  return Math.abs(da - db) / 86400000;
}

export function plaidPayeeText(t: PlaidTransaction): string {
  return normalizeMerchant(t.merchant_name || cleanName(t.name) || t.name || "");
}
