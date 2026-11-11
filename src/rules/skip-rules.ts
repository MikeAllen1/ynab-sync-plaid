import { DEFAULT_SKIP_RULES, RETIRED_SKIP_RULE_IDS } from "../constants";
import { AccountConfig, Env, PlaidTransaction, SkipRule } from "../types";

export function transactionText(t: PlaidTransaction): string {
  return [t.name, t.merchant_name].filter(Boolean).join(" ").toUpperCase();
}

export function normalizeContains(value: string): string {
  return String(value || "").trim().toUpperCase();
}

export function matchesSkipRule(t: PlaidTransaction, acct: AccountConfig, rule: SkipRule): boolean {
  if (!rule.enabled) return false;
  if (rule.account !== "*" && rule.account !== acct.nickname) return false;

  const isInflow = t.amount < 0;
  const isOutflow = t.amount > 0;

  if (rule.transaction_type === "inflow" && !isInflow) return false;
  if (rule.transaction_type === "outflow" && !isOutflow) return false;

  const contains = normalizeContains(rule.contains);
  if (!contains) return false;

  if (!transactionText(t).includes(contains)) return false;

  if (Array.isArray(rule.amounts) && rule.amounts.length > 0) {
    const absoluteAmount = Math.abs(t.amount);
    return rule.amounts.some(amount => Math.abs(absoluteAmount - Number(amount)) < 0.01);
  }

  return true;
}

export function matchingSkipRule(t: PlaidTransaction, acct: AccountConfig, rules: SkipRule[]): SkipRule | null {
  for (const rule of rules) {
    if (matchesSkipRule(t, acct, rule)) return rule;
  }
  return null;
}

export function normalizeSkipRule(rule: any): SkipRule | null {
  if (!rule || typeof rule !== "object") return null;

  const id = String(rule.id || crypto.randomUUID()).trim();
  const account = String(rule.account || "*").trim();
  const contains = String(rule.contains || "").trim();
  const reason = String(rule.reason || "Skipped by dashboard rule").trim();
  const rawType = String(rule.transaction_type || "inflow");

  const transaction_type: "inflow" | "outflow" | "any" =
    rawType === "outflow" ? "outflow" :
    rawType === "any" ? "any" :
    "inflow";

  if (!id || !contains) return null;

  const amounts = Array.isArray(rule.amounts)
    ? rule.amounts.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x) && x >= 0)
    : undefined;

  return {
    id,
    enabled: rule.enabled !== false,
    account,
    contains,
    transaction_type,
    amounts: amounts && amounts.length > 0 ? amounts : undefined,
    reason
  };
}

export async function getSkipRules(env: Env): Promise<SkipRule[]> {
  const raw = await env.SYNC_STATE.get("skip_rules");
  if (!raw) return DEFAULT_SKIP_RULES;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SKIP_RULES;
    // An empty saved list means "no rules". The old built-in rules are retired, even
    // where a copy of them was saved.
    return (parsed.map(normalizeSkipRule).filter(Boolean) as SkipRule[]).filter(r => !RETIRED_SKIP_RULE_IDS.has(r.id));
  } catch {
    return DEFAULT_SKIP_RULES;
  }
}

export async function putSkipRules(env: Env, rules: SkipRule[]): Promise<SkipRule[]> {
  const normalized = rules.map(normalizeSkipRule).filter(Boolean) as SkipRule[];
  await env.SYNC_STATE.put("skip_rules", JSON.stringify(normalized, null, 2));
  return normalized;
}
