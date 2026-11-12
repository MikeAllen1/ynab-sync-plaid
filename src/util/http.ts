import { status } from "../health/status";
import { keepLeaseAlive } from "../lock/lock";
import { Env } from "../types";

// ---------- API clients ----------

// Retry transient failures (429 rate limit, 5xx) with capped exponential backoff
// + jitter. We honor Retry-After but cap the wait so a Worker never blocks for
// long — if a 429 won't clear within the cap, we give up and the next scheduled
// run picks up where we left off (the sync is idempotent via import_id + cursor).
export const OUTBOUND_TIMEOUT_MS = 30_000;
// Alert emails and alert webhooks are best-effort and some run while the sync lock is held.
export const ALERT_TIMEOUT_MS = 10_000;

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
      // Bounded: a hung provider call would otherwise hold the sync lock until its lease
      // expires. A timed-out write is an ambiguous transport error like any other (not
      // replayed); stable import ids let the next run reconcile it.
      resp = await fetch(url, init.signal ? init : { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
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

// A fresh random nonce per page load, for the page's own <script> tags.
export function newCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Headers for the admin HTML pages. script-src allows only this response's nonce (and,
// on /setup, Plaid Link's loader), so even if a bank-supplied payee name ever slipped
// past escaping, injected markup could not run script. Inline event handlers are not
// used anywhere for the same reason. Styles stay inline-friendly: they can't run code.
export function pageSecurityHeaders(nonce: string, page: "dashboard" | "setup" = "dashboard"): Record<string, string> {
  const plaid = page === "setup";
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${plaid ? " https://cdn.plaid.com/link/v2/stable/link-initialize.js" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${plaid ? " https://*.plaid.com" : ""}`,
    ...(plaid ? ["frame-src https://cdn.plaid.com"] : []),
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join("; ");
  return { ...NO_FRAMING, "Content-Security-Policy": csp };
}

// ---------- Security / utilities ----------

export const ADMIN_SESSION_COOKIE = "__Host-ynab_admin";

// Session cookies are stateless HMACs keyed by ADMIN_TOKEN, plus a session epoch held
// in the SyncLock Durable Object. Bumping the epoch (signing out) invalidates every
// session cookie already issued, on every browser, before it expires. Rotating
// ADMIN_TOKEN does the same.
async function signSession(adminToken: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(adminToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function createAdminSessionValue(adminToken: string, issuedAt = Math.floor(Date.now() / 1000), epoch = 0): Promise<string> {
  const payload = `v2.${issuedAt}.${epoch}`;
  return `${payload}.${await signSession(adminToken, payload)}`;
}

/** Current session epoch. 0 without the Durable Object; throws if it can't be read. */
export async function getSessionEpoch(env: Env): Promise<number> {
  if (!env.SYNC_LOCK) return 0;
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const resp = await stub.fetch("https://sync-lock/session/epoch");
  if (!resp.ok) throw new Error(`session epoch unavailable (${resp.status})`);
  const data: any = await resp.json();
  const epoch = Number(data?.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("session epoch invalid");
  return epoch;
}

/** Invalidate every admin session issued so far. */
export async function bumpSessionEpoch(env: Env): Promise<number> {
  if (!env.SYNC_LOCK) throw new Error("Signing out every session needs the SYNC_LOCK Durable Object.");
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const resp = await stub.fetch("https://sync-lock/session/epoch/bump", { method: "POST" });
  if (!resp.ok) throw new Error(`session epoch bump failed (${resp.status})`);
  const data: any = await resp.json();
  return Number(data?.epoch);
}

export async function isValidAdminSessionCookie(req: Request, env: Env): Promise<boolean> {
  const cookieValue = (req.headers.get("Cookie") || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(ADMIN_SESSION_COOKIE + "="))?.slice(ADMIN_SESSION_COOKIE.length + 1);
  if (!cookieValue || !env.ADMIN_TOKEN) return false;
  try {
    const decoded = decodeURIComponent(cookieValue);
    // v2.<issuedAt>.<epoch>.<hmac>; legacy v1.<issuedAt>.<hmac> counts as epoch 0.
    const v2 = /^v2\.(\d+)\.(\d+)\.([a-f0-9]{64})$/.exec(decoded);
    const v1 = v2 ? null : /^v1\.(\d+)\.([a-f0-9]{64})$/.exec(decoded);
    if (!v2 && !v1) return false;
    const issuedAt = Number((v2 || v1)![1]);
    const epoch = v2 ? Number(v2[2]) : 0;
    const mac = v2 ? v2[3] : v1![2];
    const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(epoch) || ageSeconds < 0 || ageSeconds > 3600) return false;
    const payload = v2 ? `v2.${issuedAt}.${epoch}` : `v1.${issuedAt}`;
    if (!constantTimeEqual(mac, await signSession(env.ADMIN_TOKEN, payload))) return false;
    // Fails closed: a session can't be honored if its epoch can't be checked.
    return epoch === await getSessionEpoch(env);
  } catch {
    return false;
  }
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

/** When the presented session cookie expires (ISO), or null. Read-only; doesn't validate. */
export function sessionExpiresAt(req: Request): string | null {
  const cookieValue = (req.headers.get("Cookie") || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(ADMIN_SESSION_COOKIE + "="))?.slice(ADMIN_SESSION_COOKIE.length + 1);
  try {
    const m = /^v\d+\.(\d+)\./.exec(decodeURIComponent(cookieValue || ""));
    return m ? new Date((Number(m[1]) + ADMIN_SESSION_SECONDS) * 1000).toISOString() : null;
  } catch { return null; }
}

export const ADMIN_SESSION_SECONDS = 3600;

export async function requireAdmin(req: Request, env: Env): Promise<Response | null> {
  const headerToken = req.headers.get("x-admin-token");

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
  if (await isValidAdminSessionCookie(req, env)) return null;
  return json({ error: "unauthorized", note: "Authenticate with the dashboard admin token." }, 401);
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
