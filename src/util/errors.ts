import { status } from "../health/status";
import { cleanName } from "../sync/matching";
import { PlaidTransaction } from "../types";

export function safePayee(t: PlaidTransaction): string {
  return (t.merchant_name || cleanName(t.name) || "Unknown").slice(0, 80);
}

// YNAB's refusal in words: `YNAB update failed: 400 - {"error":{"detail":"cannot
// change a split transaction"}}` becomes `YNAB refused it (400): cannot change a split
// transaction`. Anything else is passed through, shortened.
export function plainYnabError(error: string): string {
  const s = String(error || "");
  const status = /\b(\d{3})\b/.exec(s)?.[1] || "";
  const j = s.indexOf("{");
  if (j >= 0) {
    try {
      const d = JSON.parse(s.slice(j));
      const detail = d?.error?.detail || d?.error?.name || d?.non_json_response;
      if (detail) return `YNAB ${status.startsWith("4") ? "refused it" : "had a problem"}${status ? ` (${status})` : ""}: ${String(detail).slice(0, 160)}`;
    } catch { /* fall through */ }
  }
  return s.slice(0, 200);
}

export function friendlyErrorMessage(error: any): string {
  const raw = String(error?.message || error || "");
  const upper = raw.toUpperCase();

  // Cloudflare refuses outbound requests past the invocation's limit (50 on the Free plan).
  if (/too many subrequests/i.test(raw)) return "This bank had more new activity than one run can read on Cloudflare's Free plan (50 requests per run). It keeps retrying; other banks sync first. If it doesn't clear, raise SUBREQUEST_BUDGET on a Workers Paid plan.";
  if (/timed out after|isn't responding \(timed out/.test(raw)) {
    const host = /(api\.ynab\.com|[a-z]+\.plaid\.com|api\.resend\.com)/.exec(raw)?.[1] || "the provider";
    return `${host.includes("ynab") ? "YNAB" : host.includes("plaid") ? "Plaid" : host} didn't answer in time. This is usually temporary; the next sync retries.`;
  }

  // YNAB first: a YNAB error body can contain words like "internal_server_error"
  // that would otherwise read as a Plaid problem.
  if (upper.startsWith("YNAB")) {
    const s = /^YNAB [^:]*?(?:FAILED)?:?\s*(\d{3})/.exec(upper)?.[1] || /\b(401|403|404|429|5\d\d)\b/.exec(upper)?.[1];
    if (s === "401") return "YNAB rejected the API token. Generate a new YNAB token and update the Worker secret.";
    if (s === "403") return "YNAB refused access to this budget. Check the token's permissions and YNAB_BUDGET_ID.";
    if (s === "404") return "YNAB budget or account ID was not found. Check YNAB_BUDGET_ID and each account's YNAB account in Settings.";
    if (s === "429") return "YNAB API rate limit hit. The next scheduled sync retries.";
    if (s && s.startsWith("5")) return "YNAB is having trouble right now. This is usually temporary; the next sync retries.";
    return raw;
  }

  if (upper.includes("ITEM_LOGIN_REQUIRED")) return "Plaid says this bank needs to be reconnected.";
  if (upper.includes("INVALID_ACCESS_TOKEN")) return "Plaid access token is invalid or revoked. Reconnect the bank from the setup page (/setup).";
  if (upper.includes("PRODUCT_NOT_READY")) return "Plaid is not ready yet for this institution. Wait a bit and try again.";
  if (upper.includes("RATE_LIMIT_EXCEEDED")) return "Plaid rate limit hit. Stop manual refreshes for a bit and let scheduled sync run.";
  if (upper.includes("INTERNAL_SERVER_ERROR") || upper.includes("PLANNED_MAINTENANCE")) return "Plaid had a temporary problem. The next sync retries.";
  if (upper.includes("INSTITUTION_DOWN")) return "The bank connection is temporarily unavailable on Plaid's side.";
  if (upper.includes("INSTITUTION_NOT_RESPONDING")) return "The bank is not responding through Plaid right now. This is usually temporary.";
  if (upper.includes("MFA_NOT_SUPPORTED")) return "Plaid could not complete multi-factor authentication for this bank.";
  if (upper.includes("WEBHOOK")) return "Plaid webhook configuration failed. Check the Worker URL and Plaid Item access.";
  // Any YNAB call (reads included, which usually fail first), not just creates.
  const ynabStatus = /^YNAB [^:]*?(?:FAILED)?:?\s*(\d{3})/.exec(upper)?.[1] || (upper.startsWith("YNAB") ? /\b(401|403|404|429|5\d\d)\b/.exec(upper)?.[1] : undefined);
  if (ynabStatus === "401") return "YNAB rejected the API token. Generate a new YNAB token and update the Worker secret.";
  if (ynabStatus === "403") return "YNAB refused access to this budget. Check the token's permissions and YNAB_BUDGET_ID.";
  if (ynabStatus === "404") return "YNAB budget or account ID was not found. Check YNAB_BUDGET_ID and each account's YNAB account in Settings.";
  if (ynabStatus === "429") return "YNAB API rate limit hit. The next scheduled sync retries.";
  if (ynabStatus && ynabStatus.startsWith("5")) return "YNAB is having trouble right now. This is usually temporary; the next sync retries.";
  if (upper.startsWith("PLAID") && /\b5\d\d\b/.test(upper)) return "Plaid is having trouble right now. This is usually temporary; the next sync retries.";

  return raw || "Unknown error. Check Developer Output or run npx wrangler tail.";
}
