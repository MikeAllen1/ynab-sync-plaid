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
  options: { retrySafe?: boolean; beforeAttempt?: () => Promise<void> } | boolean = {}
): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase();
  const safeToRetry = typeof options === "boolean"
    ? options
    : options.retrySafe === true || ["GET", "HEAD", "OPTIONS"].includes(method);
  let attempt = 0;
  while (true) {
    await keepLeaseAlive();
    if (typeof options !== "boolean" && options.beforeAttempt) await options.beforeAttempt();
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (error) {
      // A transport error after a mutation is ambiguous: the remote service may
      // have committed it. Never replay writes unless the caller explicitly
      // establishes that the operation is safe to repeat.
      await keepLeaseAlive();
      if (!safeToRetry || attempt >= retries) throw error;
      await sleep(Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
      attempt++;
      continue;
    }
    // Revalidate ownership before the caller can consume the response or issue
    // a subsequent financial mutation.
    await keepLeaseAlive();
    if (safeToRetry && (resp.status === 429 || resp.status >= 500) && attempt < retries) {
      const backoffMs = retryAfterDelayMs(resp.headers.get("Retry-After"), attempt);
      // Do not shorten a provider-specified delay; defer to the next scheduled
      // execution when it exceeds this Worker request's bounded retry window.
      if (backoffMs > 10000) return resp;
      try { await resp.body?.cancel(); } catch { /* retry only if semantics are safe */ }
      await sleep(backoffMs);
      attempt++;
      continue;
    }
    return resp;
  }
}

export function retryAfterDelayMs(header: string | null, attempt: number, now = Date.now()): number {
  if (header !== null && header.trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
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

// ---------- Admin-token attempt throttling ----------
// The admin token is long and random, so guessing it is impractical; this is defense
// in depth. Failed attempts are counted per client IP and globally in the SyncLock
// Durable Object. If the Durable Object can't be reached, attempts are not throttled
// (the token is still required): an outage must never lock the owner out.

function authKeys(req: Request): string[] {
  const ip = (req.headers.get("CF-Connecting-IP") || "unknown").replace(/[^\w.:-]/g, "").slice(0, 80) || "unknown";
  return [`ip:${ip}`, "global:all"];
}

async function authLimiter(env: Env, req: Request, action: "check" | "fail"): Promise<{ blocked: boolean; retry_after_seconds: number }> {
  if (!env.SYNC_LOCK) return { blocked: false, retry_after_seconds: 0 };
  try {
    const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
    const resp = await stub.fetch(`https://sync-lock/auth/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: authKeys(req) })
    });
    if (!resp.ok) return { blocked: false, retry_after_seconds: 0 };
    const data: any = await resp.json();
    return { blocked: data?.blocked === true, retry_after_seconds: Number(data?.retry_after_seconds) || 0 };
  } catch {
    return { blocked: false, retry_after_seconds: 0 };
  }
}

export function tooManyAttempts(retryAfterSeconds: number): Response {
  const resp = json({ error: "too many failed sign-in attempts; try again later", retry_after_seconds: retryAfterSeconds }, 429);
  resp.headers.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
  return resp;
}

/**
 * Check a presented admin token with throttling. Returns null when it matches,
 * otherwise a 401 or 429 response to send back.
 */
export async function checkAdminTokenAttempt(req: Request, env: Env, supplied: string): Promise<Response | null> {
  const before = await authLimiter(env, req, "check");
  if (before.blocked) return tooManyAttempts(before.retry_after_seconds);
  if (supplied && env.ADMIN_TOKEN && constantTimeEqual(supplied, env.ADMIN_TOKEN)) return null;
  const after = await authLimiter(env, req, "fail");
  if (after.blocked) return tooManyAttempts(after.retry_after_seconds);
  return json({ ok: false, error: "unauthorized", note: "Authenticate with the dashboard admin token." }, 401);
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

  // A request that presents a header token is judged by that header alone (through
  // the attempt throttle). Header requests are exempt from the browser Origin check,
  // so they must never be rescued by an ambient cookie.
  if (headerToken !== null) {
    const refused = await checkAdminTokenAttempt(req, env, headerToken);
    if (refused) return refused;
    return null;
  }

  if (!cookieValid) {
    return json({ error: "unauthorized", note: "Authenticate with the dashboard admin token." }, 401);
  }

  return null;
}

/** True when the request authenticates with the x-admin-token header rather than a cookie. */
export function isHeaderAuthenticated(req: Request): boolean {
  return req.headers.get("x-admin-token") !== null;
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
