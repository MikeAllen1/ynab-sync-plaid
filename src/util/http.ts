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

export async function createAdminSessionValue(env: Env): Promise<string> {
  if (!env.SYNC_LOCK) throw new Error("SYNC_LOCK is required for revocable admin sessions");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const sessionId = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/session/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint, expiresAt: Date.now() + 3600000 })
  });
  if (!response.ok) throw new Error("Admin session registry unavailable");
  return sessionId;
}

async function isAdminSessionValid(env: Env, sessionId: string): Promise<boolean> {
  if (!env.SYNC_LOCK || !/^[a-f0-9]{64}$/.test(sessionId)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/session/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint })
  });
  if (!response.ok) return false;
  const data: any = await response.json();
  return data.valid === true;
}

export async function revokeAdminSession(env: Env, sessionId: string): Promise<void> {
  if (!env.SYNC_LOCK || !/^[a-f0-9]{64}$/.test(sessionId)) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/session/revoke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint })
  });
  if (!response.ok) throw new Error("Admin session revocation unavailable");
}

export async function requireAdmin(req: Request, env: Env): Promise<Response | null> {
  const headerToken = req.headers.get("x-admin-token");
  const cookieValue = (req.headers.get("Cookie") || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(ADMIN_SESSION_COOKIE + "="))?.slice(ADMIN_SESSION_COOKIE.length + 1);
  let cookieValid = false;
  try {
    const decoded = cookieValue ? decodeURIComponent(cookieValue) : "";
    if (/^[a-f0-9]{64}$/.test(decoded)) cookieValid = await isAdminSessionValid(env, decoded);
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
