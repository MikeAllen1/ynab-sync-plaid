import { status } from "../health/status";
import { keepLeaseAlive } from "../lock/lock";
import { Env } from "../types";

// ---------- API clients ----------

// Retry transient failures (429 rate limit, 5xx) with capped exponential backoff
// + jitter. We honor Retry-After but cap the wait so a Worker never blocks for
// long — if a 429 won't clear within the cap, we give up and the next scheduled
// run picks up where we left off (the sync is idempotent via import_id + cursor).
export async function fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  let attempt = 0;
  while (true) {
    await keepLeaseAlive();
    const resp = await fetch(url, init);
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      const retryAfter = Number(resp.headers.get("Retry-After"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10000)
        : Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
      attempt++;
      continue;
    }
    return resp;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A gateway in front of Plaid or YNAB can answer an outage with an HTML page. Parse
// JSON when it is JSON; otherwise keep a short excerpt so the error names the status
// ("502") instead of "Unexpected token <".
export async function readJsonBody(resp: Response): Promise<any> {
  let text = "";
  try { text = await resp.text(); } catch { return {}; }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { non_json_response: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) }; }
}

// The admin pages can't be framed by another site (click-jacking).
export const NO_FRAMING = { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" };

// ---------- Security / utilities ----------

export function requireAdmin(req: Request, env: Env): Response | null {
  const provided = req.headers.get("x-admin-token");

  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured. Run: npx wrangler secret put ADMIN_TOKEN" }, 500);
  }

  if (!provided || !constantTimeEqual(provided, env.ADMIN_TOKEN)) {
    return json({ error: "unauthorized", note: "Provide x-admin-token header." }, 401);
  }

  return null;
}

// Constant-time string comparison: avoids leaking how many leading characters
// of the token matched via early-exit timing. Runs to the longer of the two
// lengths and folds any length mismatch into the result.
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
