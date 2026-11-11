import { readJson } from "../health/status";
import { Env, SkippedIncomeRecord } from "../types";
import { json } from "../util/http";

// ---------- Concurrency guard ----------
//
// Every operation that writes YNAB or sync state (sync, bootstrap, cleanups, undo,
// repair, reset-card, account edits) runs under one global lock, so none of them can
// act on a register snapshot another run is changing.
//
// Preferred: the SyncLock Durable Object (atomic, owner-tokened, renewable). If the
// DO binding exists but can't be reached, the operation is SKIPPED rather than run
// unprotected; cron retries in 15 minutes. Without a DO binding at all, a KV lock is
// used, which is best-effort only (KV get-then-put is not atomic); that mode is
// reported as lock_mode "kv-best-effort" so it is never mistaken for a real mutex.
export const SYNC_LOCK_KEY = "sync:lock";
// Longer than any realistic run (three accounts, capped retries). Runs renew the
// lease between accounts, so a slow run keeps its lock.
export const SYNC_LOCK_TTL_SECONDS = 900;
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
  const existing = await env.SYNC_STATE.get(SYNC_LOCK_KEY);
  if (existing) return null;
  const id = crypto.randomUUID();
  await env.SYNC_STATE.put(SYNC_LOCK_KEY, id, { expirationTtl: SYNC_LOCK_TTL_SECONDS });
  return { id, mode: "kv-best-effort" };
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
    lease.renewedAt = now;
    await renewSyncLock(lease.env, lease.lock);
  }
}

export async function renewSyncLock(env: Env, lock: LockHandle): Promise<void> {
  try {
    if (lock.mode === "durable-object" && env.SYNC_LOCK) {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
      await stub.fetch(`https://sync-lock/renew?id=${encodeURIComponent(lock.id)}`, { method: "POST" });
    } else if (lock.mode === "kv-best-effort" && (await env.SYNC_STATE.get(SYNC_LOCK_KEY)) === lock.id) {
      await env.SYNC_STATE.put(SYNC_LOCK_KEY, lock.id, { expirationTtl: SYNC_LOCK_TTL_SECONDS });
    }
  } catch { /* the TTL is generous; a missed renewal is not fatal */ }
}

export async function releaseSyncLock(env: Env, lock: LockHandle): Promise<void> {
  if (lock.mode === "durable-object" && env.SYNC_LOCK) {
    try {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName(SYNC_LOCK_DO_ID));
      await stub.fetch(`https://sync-lock/release?id=${encodeURIComponent(lock.id)}`, { method: "POST" });
    } catch { /* expires on its own */ }
    return;
  }
  if ((await env.SYNC_STATE.get(SYNC_LOCK_KEY)) === lock.id) await env.SYNC_STATE.delete(SYNC_LOCK_KEY);
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
    return json(await fn());
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
