import { normalizeMerchant } from "../sync/matching";
import { Env } from "../types";

// ---------- Payee aliases ----------
//
// Some merchants appear under different names depending on the source: Plaid's raw
// bank descriptor vs. YNAB Direct Import's cleaned name. Example: "OLDCO
// BILLPAY" (Plaid) is the same merchant as "NewCo Energy" (YNAB), but they
// share no words, so content-based dedup misses the match and a duplicate slips in.
// An alias group declares a canonical name plus the fragments that mean it; during
// name comparison both sides are canonicalized first, so the duplicate is caught.

export interface PayeeAlias {
  canonical: string;   // human label, e.g. "NewCo Energy"
  patterns: string[];  // substrings that identify this merchant, e.g. ["oldco","newco"]
}

export const PAYEE_ALIASES_KV_KEY = "payee_aliases";
export const DEFAULT_PAYEE_ALIASES: PayeeAlias[] = [];

export async function getPayeeAliases(env: Env): Promise<PayeeAlias[]> {
  try {
    const raw = await env.SYNC_STATE.get(PAYEE_ALIASES_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_PAYEE_ALIASES;
}

export async function putPayeeAliases(env: Env, aliases: any[]): Promise<PayeeAlias[]> {
  const normalized: PayeeAlias[] = (Array.isArray(aliases) ? aliases : [])
    .map(a => ({
      canonical: String(a?.canonical || "").trim(),
      patterns: Array.isArray(a?.patterns)
        ? a.patterns.map((p: any) => String(p || "").trim()).filter(Boolean)
        : []
    }))
    .filter(a => a.canonical && a.patterns.length > 0);
  await env.SYNC_STATE.put(PAYEE_ALIASES_KV_KEY, JSON.stringify(normalized, null, 2));
  return normalized;
}

// Aliases are passed in, never read from module state: each operation takes one
// snapshot when it starts, so a concurrent request that loads different aliases
// can't change how an in-flight sync matches.
export function applyPayeeAlias(normalized: string, aliases: PayeeAlias[]): string {
  if (!normalized || aliases.length === 0) return normalized;
  for (const g of aliases) {
    for (const p of g.patterns) {
      const np = normalizeMerchant(p);
      if (np && normalized.includes(np)) return normalizeMerchant(g.canonical);
    }
  }
  return normalized;
}
