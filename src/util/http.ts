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

export async function requireAdmin(req: Request, env: Env): Promise<Response | null> {
  const headerToken = req.headers.get("x-admin-token");

  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured. Run: npx wrangler secret put ADMIN_TOKEN" }, 500);
  }

  if (headerToken && constantTimeEqual(headerToken, env.ADMIN_TOKEN)) return null;
  if (await isValidAdminSessionCookie(req, env)) return null;
  return json({ error: "unauthorized", note: "Authenticate with the dashboard admin token." }, 401);
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
