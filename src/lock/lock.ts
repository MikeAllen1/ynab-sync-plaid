import { readJson } from "../health/status";
import { Env, SkippedIncomeRecord } from "../types";
import { json } from "../util/http";

// ---------- Concurrency guard ----------
//
// Every operation that writes YNAB or sync state (sync, bootstrap, cleanups, undo,
// repair, reset-card, account edits) runs under one global lock, so none of them can
// act on a register snapshot another run is changing.
//
// Required: the SyncLock Durable Object (atomic, owner-tokened, renewable).
// If the binding is absent or unreachable, the operation is skipped rather than
// run unprotected; cron retries in 15 minutes. KV get-then-put is not atomic and
// must never be used as a mutex for financial writes.
export const SYNC_LOCK_KEY = "sync:lock";
// Runs renew the lease between accounts and around every outbound call (at most once
// a minute), and every outbound call is capped at OUTBOUND_TIMEOUT_MS, so a live run
// renews well within this. Kept short because a run Cloudflare cancels (a webhook sync
// past waitUntil's 30 seconds) never reaches its release: until the lease runs out,
// every sync, Sync now and dashboard change answers "busy". Was 900 s.
export const SYNC_LOCK_TTL_SECONDS = 180;
export const SYNC_LOCK_DO_ID = "global";

export interface LockHandle { id: string; mode: "durable-object" | "kv-best-effort"; }

// Set when the lock service could not be reached (as opposed to being held), so
// callers can say so instead of "busy".
export let lastLockUnreachable = false;

export async function acquireSyncLock(env: Env): Promise<LockHandle | null> {
  lastLockUnreachable = false;
  if (env.SYNC_LOCK) {
    try {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
      const data: any = await (await stub.fetch("https://sync-lock/acquire", { method: "POST" })).json();
      return data.acquired ? { id: data.id, mode: "durable-object" } : null;
    } catch {
      lastLockUnreachable = true;
      return null; // DO configured but unreachable: do not run unprotected
    }
  }
  // KV get-then-put is not atomic. Treat a missing binding as a configuration
  // failure instead of allowing concurrent writers to enter the sync engine.
  lastLockUnreachable = true;
  return null;
}

// Leases held by operations running in this isolate. Every outbound Plaid/YNAB call
// renews them (at most once a minute each), so a lock stays held for as long as its
// operation is doing work: through long cursor backlogs, pagination and retries,
// not just between accounts. Keyed by lock id, so concurrent requests in the same
// isolate can never overwrite each other's lease; each is added and removed only by
// the operation that owns it. A renewal triggered by another request's API call
// only ever extends a lock whose operation is still running.
export const activeLeases = new Map<string, { env: Env; lock: LockHandle; renewedAt: number }>();
export const LEASE_RENEW_EVERY_MS = 60 * 1000;

export function holdLease(env: Env, lock: LockHandle): void {
  activeLeases.set(lock.id, { env, lock, renewedAt: Date.now() });
}
export function dropLease(lock: LockHandle): void {
  activeLeases.delete(lock.id);
}
export async function keepLeaseAlive(): Promise<void> {
  const now = Date.now();
  for (const lease of activeLeases.values()) {
    if (now - lease.renewedAt < LEASE_RENEW_EVERY_MS) continue;
    await renewSyncLock(lease.env, lease.lock);
  }
}

export async function renewSyncLock(env: Env, lock: LockHandle): Promise<void> {
  if (lock.mode !== "durable-object" || !env.SYNC_LOCK) {
    throw new Error("SYNC_LOCK lease cannot be renewed; aborting financial writes.");
  }
  let response: Response;
  try {
    const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
    response = await stub.fetch(`https://sync-lock/renew?id=${encodeURIComponent(lock.id)}`, { method: "POST" });
  } catch {
    throw new Error("SYNC_LOCK lease renewal failed; aborting financial writes.");
  }
  if (!response.ok) {
    throw new Error(`SYNC_LOCK lease renewal failed (HTTP ${response.status}); aborting financial writes.`);
  }
  let data: any;
  try { data = await response.json(); } catch {
    throw new Error("SYNC_LOCK lease renewal returned an invalid response; aborting financial writes.");
  }
  if (data?.renewed !== true) {
    throw new Error("SYNC_LOCK lease is no longer owned by this run; aborting financial writes.");
  }
  const active = activeLeases.get(lock.id);
  if (active) active.renewedAt = Date.now();
}

export async function releaseSyncLock(env: Env, lock: LockHandle): Promise<void> {
  if (lock.mode === "durable-object" && env.SYNC_LOCK) {
    try {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
      await stub.fetch(`https://sync-lock/release?id=${encodeURIComponent(lock.id)}`, { method: "POST" });
    } catch { /* expires on its own */ }
    return;
  }
  // Only Durable Object locks can be acquired. No KV fallback is permitted.
}

// Run a mutating admin operation under the lock; 409 if something else holds it.
export async function lockedJson(env: Env, fn: () => Promise<any>): Promise<Response> {
  const lock = await acquireSyncLock(env);
  if (!lock) {
    if (lastLockUnreachable) return json({ ok: false, error: "The sync lock service (SYNC_LOCK Durable Object) couldn't be reached, so nothing was changed. Check the worker's Durable Object binding in Cloudflare." }, 503);
    return json({ ok: false, busy: true, error: "A sync or another change is in progress. Nothing was changed; try again in a minute." }, 409);
  }
  holdLease(env, lock);
  try {
    // A handler may answer with its own Response (for example a 409 when the page
    // that sent a save is out of date); anything else is wrapped as JSON.
    const result = await fn();
    return result instanceof Response ? result : json(result);
  } finally {
    dropLease(lock);
    await releaseSyncLock(env, lock);
  }
}

export async function isSyncEnabled(env: Env): Promise<boolean> {
  // Absent means enabled. Reading never writes, so a dry run stays side-effect free.
  return (await env.SYNC_STATE.get("sync:enabled")) !== "false";
}

export async function appendSkippedIncomeHistory(env: Env, records: SkippedIncomeRecord[]): Promise<void> {
  // The verification window re-sees the same skipped item every run; record each once.
  const existing: SkippedIncomeRecord[] = await readJson(env, "skipped_income_history", []);
  const key = (r: SkippedIncomeRecord) => `${r.account}|${r.date}|${r.amount}|${r.payee}`;
  const seen = new Set(existing.map(key));
  const fresh = records.filter(r => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
  if (fresh.length === 0) return;
  await env.SYNC_STATE.put("skipped_income_history", JSON.stringify([...fresh, ...existing].slice(0, 30)));
}

// Reserve every outbound YNAB HTTP attempt against a strongly consistent rolling
// one-hour budget. The API limit is 200/hour; cap this worker at 180 to leave room
// for manual clients using the same token. A failed reservation fails closed.
export async function reserveYnabRequest(env: Env): Promise<void> {
  if (!env.SYNC_LOCK) throw new Error("YNAB request budget unavailable: SYNC_LOCK Durable Object is not configured.");
  let response: Response;
  try {
    const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
    response = await stub.fetch("https://sync-lock/ynab-rate/reserve", { method: "POST" });
  } catch {
    throw new Error("YNAB request budget unavailable: SYNC_LOCK Durable Object could not be reached; no YNAB request was sent.");
  }
  let data: any;
  try { data = await response.json(); } catch { throw new Error("YNAB request budget returned an invalid response; no YNAB request was sent."); }
  if (!response.ok || data?.reserved !== true) {
    throw new Error(`YNAB request budget exhausted or unavailable (${response.status}); request deferred to a later run.`);
  }
}
