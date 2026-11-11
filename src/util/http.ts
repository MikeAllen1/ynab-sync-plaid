import { status } from "../health/status";
import { keepLeaseAlive } from "../lock/lock";
import { Env } from "../types";

// ---------- API clients ----------

// Retry transient failures (429 rate limit, 5xx) with capped exponential backoff
// + jitter. We honor Retry-After but cap the wait so a Worker never blocks for
// long — if a 429 won't clear within the cap, we give up and the next scheduled
// run picks up where we left off (the sync is idempotent via import_id + cursor).
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
  retrySafe = ["GET", "HEAD", "OPTIONS"].includes(String(init.method || "GET").toUpperCase())
): Promise<Response> {
  let attempt = 0;
  while (true) {
    await keepLeaseAlive();
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (error) {
      // A transport error after a mutation is ambiguous: the remote service may
      // have committed it. Never replay writes unless the caller explicitly
      // establishes that the operation is safe to repeat.
      if (!retrySafe || attempt >= retries) throw error;
      await sleep(Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
      attempt++;
      continue;
    }
    if (retrySafe && (resp.status === 429 || resp.status >= 500) && attempt < retries) {
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
export const NO_FRAMING = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

// ---------- Security / utilities ----------

export const ADMIN_SESSION_COOKIE = "__Host-ynab_admin";

export async function createAdminSessionValue(adminToken: string, issuedAt = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(adminToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${issuedAt}`));
  const hex = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `v1.${issuedAt}.${hex}`;
}

export async function requireAdmin(req: Request, env: Env): Promise<Response | null> {
  const headerToken = req.headers.get("x-admin-token");
  const cookieValue = (req.headers.get("Cookie") || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(ADMIN_SESSION_COOKIE + "="))?.slice(ADMIN_SESSION_COOKIE.length + 1);
  let cookieValid = false;
  try {
    const decoded = cookieValue ? decodeURIComponent(cookieValue) : "";
    const match = /^v1\.(\d+)\.([a-f0-9]{64})$/.exec(decoded);
    if (match) {
      const issuedAt = Number(match[1]);
      const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
      if (Number.isSafeInteger(issuedAt) && ageSeconds >= 0 && ageSeconds <= 3600 && env.ADMIN_TOKEN) {
        const key = await crypto.subtle.importKey(
          "raw", new TextEncoder().encode(env.ADMIN_TOKEN),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${issuedAt}`));
        const expected = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
        cookieValid = constantTimeEqual(match[2], expected);
      }
    }
  } catch { cookieValid = false; }

  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured. Run: npx wrangler secret put ADMIN_TOKEN" }, 500);
  }

  if (!cookieValid && (!headerToken || !constantTimeEqual(headerToken, env.ADMIN_TOKEN))) {
    return json({ error: "unauthorized", note: "Authenticate with the dashboard admin token." }, 401);
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }
  });
}
