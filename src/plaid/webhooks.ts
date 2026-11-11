import { runItemHealthCheck } from "../health/items";
import { isSyncEnabled } from "../lock/lock";
import { plaidCall } from "./client";
import { getEnabledAccounts } from "../store/accounts";
import { markItemDue, syncAll } from "../sync/run";
import { AccountConfig, Env } from "../types";
import { friendlyErrorMessage } from "../util/errors";
import { constantTimeEqual } from "../util/http";

// ---------- Plaid refresh + webhook support ----------

// Verifies a Plaid webhook using the JWT in the Plaid-Verification header.
// Plaid signs with ES256 (ECDSA P-256). We fetch the public key for the JWT's
// key id, verify the signature, confirm the body hash claim matches the raw
// body we received, and reject stale tokens to block replay. Any failure ->
// false, and the caller refuses to run the sync.
export async function verifyPlaidWebhook(env: Env, rawBody: string, verificationHeader: string | null): Promise<boolean> {
  if (!verificationHeader) return false;

  const parts = verificationHeader.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, sigB64] = parts;

  let header: any;
  try {
    header = JSON.parse(b64urlToText(headerB64));
  } catch {
    return false;
  }

  // Plaid only signs webhooks with ES256. Reject anything else (incl. "none").
  if (header.alg !== "ES256" || !header.kid) return false;
  // Cheap checks before any key lookup: a stale or undated token is refused without
  // a call to Plaid or a KV read.
  try {
    const p = JSON.parse(b64urlToText(payloadB64));
    if (typeof p.iat !== "number" || Math.abs(Math.floor(Date.now() / 1000) - p.iat) > 300) return false;
  } catch { return false; }

  const jwk = await getPlaidVerificationKey(env, header.kid);
  if (!jwk) return false;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return false;
  }

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let sigValid = false;
  try {
    sigValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlToBytes(sigB64),
      signedData
    );
  } catch {
    return false;
  }
  if (!sigValid) return false;

  let payload: any;
  try {
    payload = JSON.parse(b64urlToText(payloadB64));
  } catch {
    return false;
  }

  // Replay protection: Plaid recommends rejecting tokens older than 5 minutes.
  const nowSec = Math.floor(Date.now() / 1000);
  // A token without an issue time can't be checked for age, so it's refused.
  if (typeof payload.iat !== "number" || Math.abs(nowSec - payload.iat) > 300) return false;

  // Body integrity: the signed token commits to a hash of the exact body bytes.
  if (typeof payload.request_body_sha256 !== "string") return false;
  const actualHash = await sha256Hex(rawBody);
  return constantTimeEqual(actualHash, payload.request_body_sha256);
}

export async function getPlaidVerificationKey(env: Env, kid: string): Promise<any | null> {
  const cacheKey = `plaid_wh_key:${kid}`;
  const cached = await env.SYNC_STATE.get(cacheKey);
  if (cached) {
    try {
      const jwk = JSON.parse(cached);
      // Plaid retires keys by setting expired_at; a retired key never verifies.
      if (jwk && jwk.expired_at) return null;
      return jwk;
    } catch {
      // fall through and re-fetch
    }
  }
  // Unknown key ids are remembered (in memory, not KV, so forged requests can't use up
  // the daily KV write allowance), and this instance asks Plaid about new key ids at
  // most WH_KEY_LOOKUPS_PER_WINDOW times per 10 minutes. Plaid rotates keys rarely, so
  // a real new key is looked up on its first webhook.
  const nowMs = Date.now();
  if ((whKeyMisses.get(kid) || 0) > nowMs) return null;
  if (nowMs - whLookupWindow.start > 600000) { whLookupWindow.start = nowMs; whLookupWindow.count = 0; }
  if (whLookupWindow.count >= WH_KEY_LOOKUPS_PER_WINDOW) return null;
  whLookupWindow.count++;

  try {
    const r = await plaidCall(env, "/webhook_verification_key/get", { key_id: kid });
    const jwk = r.key;
    if (jwk && jwk.expired_at) return null;
    if (jwk && jwk.kty && jwk.x && jwk.y) {
      // Keys rotate; cache for a day so we're not fetching on every webhook.
      await env.SYNC_STATE.put(cacheKey, JSON.stringify(jwk), { expirationTtl: 86400 });
      return jwk;
    }
  } catch {
    // Unable to fetch key -> verification fails closed.
  }
  if (whKeyMisses.size > 1000) whKeyMisses.clear();
  whKeyMisses.set(kid, nowMs + 600000);
  return null;
}
export const whKeyMisses = new Map<string, number>();
export const whLookupWindow = { start: 0, count: 0 };
export const WH_KEY_LOOKUPS_PER_WINDOW = 5;

export function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  b64 += "=".repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function b64urlToText(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function handlePlaidWebhook(rawBody: string, env: Env, ctx: ExecutionContext): Promise<any> {
  let body: any = {};
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = {};
  }

  const event = {
    ts: new Date().toISOString(),
    webhook_type: body.webhook_type || null,
    webhook_code: body.webhook_code || null,
    item_id: body.item_id || null,
    environment: body.environment || null
  };

  await appendWebhookHistory(env, event);

  const transactionWebhookCodesThatShouldSync = [
    "SYNC_UPDATES_AVAILABLE",
    "DEFAULT_UPDATE",
    "INITIAL_UPDATE",
    "HISTORICAL_UPDATE",
    "TRANSACTIONS_REMOVED"
  ];

  if (
    body.webhook_type === "TRANSACTIONS" &&
    transactionWebhookCodesThatShouldSync.includes(body.webhook_code)
  ) {
    // SYNC_UPDATES_AVAILABLE means new data is ready for THIS item right now. Without
    // passing the item through, the cron tick that asked Plaid to refresh a minute
    // earlier has just stamped the account as synced, the frequency gate says "not
    // due", and the data waits a full interval.
    const webhookItemId = body.item_id ? String(body.item_id) : undefined;
    // Webhook delivery is only a trigger, not a durable job queue. Cloudflare may
    // terminate waitUntil work; the scheduled full sync is the recovery backstop.
    // Record failures and make this item due so the next cron run does not suppress
    // recovery behind the normal per-account frequency gate.
    ctx.waitUntil((async () => {
      try {
        const result = await syncAll(env, { trigger: `webhook:${body.webhook_code}`, webhookItemId });
        if (result?.status === "completed_with_errors" || result?.status === "completed_partial" ||
            result?.status === "lock_unavailable") {
          if (webhookItemId) await markItemDue(env, webhookItemId);
          await env.SYNC_STATE.put("last_webhook_sync_failure", JSON.stringify({
            ts: new Date().toISOString(), webhook_code: body.webhook_code,
            item_id: webhookItemId || null, status: result.status
          }));
        } else if (result?.status === "completed") {
          await env.SYNC_STATE.delete("last_webhook_sync_failure");
        }
      } catch (error: any) {
        try {
          if (webhookItemId) await markItemDue(env, webhookItemId);
          await env.SYNC_STATE.put("last_webhook_sync_failure", JSON.stringify({
            ts: new Date().toISOString(), webhook_code: body.webhook_code,
            item_id: webhookItemId || null, error: friendlyErrorMessage(error)
          }));
        } catch { /* cron's full sync remains the final recovery path */ }
      }
    })());
    return { ok: true, action: "sync_scheduled", event };
  }

  // Connection problems (ERROR, PENDING_EXPIRATION, LOGIN_REPAIRED...) re-check
  // connection health now instead of up to 6 hours later, so the reconnect email
  // goes out promptly.
  if (body.webhook_type === "ITEM") {
    // PENDING_EXPIRATION is Plaid's advance warning that a login will expire soon;
    // /item/get shows no error until it actually does, so remember the warning.
    // A repaired login (LOGIN_REPAIRED) or a new consent clears it.
    if (body.item_id) {
      if (body.webhook_code === "PENDING_EXPIRATION" || body.webhook_code === "PENDING_DISCONNECT") {
        await env.SYNC_STATE.put(`item_pending_expiration:${body.item_id}`, new Date().toISOString());
      } else if (body.webhook_code === "LOGIN_REPAIRED") {
        await env.SYNC_STATE.delete(`item_pending_expiration:${body.item_id}`);
      }
    }
    ctx.waitUntil(runItemHealthCheck(env, true).catch(() => {}));
    return { ok: true, action: "item_health_check_started", event };
  }

  return { ok: true, action: "recorded_only", event };
}

export async function appendWebhookHistory(env: Env, event: any): Promise<void> {
  const key = "webhook_history";
  if (!env.SYNC_LOCK) throw new Error("SYNC_LOCK is required for atomic webhook history writes");
  // Seed old KV history on first append; the DO transaction ensures only one
  // concurrent writer initializes the durable history.
  const raw = await env.SYNC_STATE.get(key);
  let initial: any[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) initial = parsed.slice(0, 20);
    } catch { /* malformed legacy history is ignored */ }
  }
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/history/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, items: [event], initial })
  });
  if (!response.ok) throw new Error(`Atomic webhook history append failed (${response.status})`);
}

export async function getWebhookHistory(env: Env): Promise<any[]> {
  if (env.SYNC_LOCK) {
    try {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
      const response = await stub.fetch("https://sync-lock/history/get?key=webhook_history");
      if (response.ok) {
        const data: any = await response.json();
        if (Array.isArray(data.items)) return data.items;
      }
    } catch {
      // Keep the dashboard readable if the DO is temporarily unavailable.
    }
  }
  const raw = await env.SYNC_STATE.get("webhook_history");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function uniqueAccessTokens(accounts: AccountConfig[]): string[] {
  return [...new Set(accounts.map(a => a.plaid_access_token).filter(Boolean))];
}

export async function forcePlaidRefresh(env: Env, origin: string, onlyTokens?: string[]): Promise<any> {
  // /transactions/refresh is billed per call on paid Plaid plans. PLAID_REFRESH = "off"
  // turns it off: new activity then arrives on Plaid's own schedule (a few times a day).
  if (String(env.PLAID_REFRESH || "").toLowerCase() === "off") return { ok: true, skipped: "PLAID_REFRESH is off", origin };
  const accounts = await getEnabledAccounts(env);
  const tokens = onlyTokens || uniqueAccessTokens(accounts);
  const results: any[] = [];

  for (const access_token of tokens) {
    const nicknames = accounts.filter(a => a.plaid_access_token === access_token).map(a => a.nickname);
    try {
      const r = await plaidCall(env, "/transactions/refresh", { access_token });
      results.push({ accounts: nicknames, status: "refresh_requested", request_id: r.request_id || null });
    } catch (e: any) {
      results.push({ accounts: nicknames, status: "error", error: e.message, friendly_error: friendlyErrorMessage(e) });
    }
  }

  // Record manual refreshes only; the cron's routine refresh would otherwise fill
  // the webhook history (and burn a KV write every 15 minutes).
  if (origin !== "cron" && origin !== "manual-sync") {
    await appendWebhookHistory(env, {
      ts: new Date().toISOString(), webhook_type: "LOCAL", webhook_code: "FORCE_REFRESH_REQUESTED",
      item_id: null, environment: env.PLAID_ENV, result_count: results.length
    });
  }

  return {
    ok: !results.some(r => r.status === "error"),
    note: "Refresh requested. Plaid sends a webhook when it finds new data; the next sync lands it.",
    webhook_url: origin === "cron" || origin === "manual-sync" ? null : `${origin}/webhook`,
    results
  };
}

// Sync now's refresh request: the logins of the enabled accounts it will sync (or just
// the one picked). Never blocks the sync; a failure is reported alongside it.
export async function refreshBeforeManualSync(env: Env, onlyAccount?: string): Promise<any> {
  try {
    if (!(await isSyncEnabled(env))) return null;
    const accounts = (await getEnabledAccounts(env)).filter(a => !onlyAccount || a.nickname === onlyAccount);
    const tokens = uniqueAccessTokens(accounts);
    if (tokens.length === 0) return null;
    return await forcePlaidRefresh(env, "manual-sync", tokens);
  } catch (e: any) {
    return { ok: false, results: [{ status: "error", friendly_error: friendlyErrorMessage(e) }] };
  }
}

export async function configurePlaidWebhooks(env: Env, origin: string): Promise<any> {
  const accounts = await getEnabledAccounts(env);
  const tokens = uniqueAccessTokens(accounts);
  const webhook = `${origin}/webhook`;
  const results: any[] = [];

  for (const access_token of tokens) {
    try {
      const r = await plaidCall(env, "/item/webhook/update", { access_token, webhook });
      results.push({
        status: "configured",
        webhook,
        item_id: r.item?.item_id || null,
        request_id: r.request_id || null
      });
    } catch (e: any) {
      results.push({ status: "error", webhook, error: e.message, friendly_error: friendlyErrorMessage(e) });
    }
  }

  return {
    ok: !results.some(r => r.status === "error"),
    webhook,
    results
  };
}
