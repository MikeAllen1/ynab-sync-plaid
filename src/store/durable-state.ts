import { Env } from "../types";

// ---------- Per-account sync state in the Durable Object ----------
//
// The lock that serializes every financial write lives in the SyncLock Durable
// Object, which is strongly consistent. The state those writes depend on (the Plaid
// cursor, which YNAB row each charge owns, which import ids were used or refused)
// used to live in KV, which is eventually consistent across Cloudflare locations: a
// webhook run handled in one location right after a cron run in another could read
// the previous cursor or links and plan against them.
//
// This keeps those keys in the same Durable Object as the lock, so a run that holds
// the lock always reads what the previous holder wrote. Everything else (settings,
// logs, summaries) stays in KV. The routing is a drop-in wrapper around
// env.SYNC_STATE, so the engine's code doesn't change.
//
// First use after deploying migrates the existing KV values into the Durable Object
// once. The import and the "migrated" mark are one storage transaction, and once the
// mark is set further imports are refused, so a slower concurrent migration can never
// bring back a value a run has since changed or removed.

export const DURABLE_STATE_PREFIXES = [
  "cursor:", "posted:", "pending:", "links:", "rejected:", "bootstrapped:", "bootstrap_date:",
  "cc_epoch:", "undo_intent:", "update_failed:", "too_old_logged:", "legs_not_worker:",
  "last_account_sync:", "quarantine_logged:"
] as const;

export function isDurableStateKey(key: string): boolean {
  return DURABLE_STATE_PREFIXES.some(p => key.startsWith(p));
}

const migratedIsolates = new WeakMap<object, Promise<void>>();

function stub(env: Env) {
  return env.SYNC_LOCK!.get(env.SYNC_LOCK!.idFromName("global"));
}

async function call(env: Env, path: string, body?: unknown): Promise<any> {
  const resp = await stub(env).fetch(`https://sync-lock${path}`, body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Sync state store (SYNC_LOCK Durable Object) failed: ${path} answered ${resp.status}. Nothing was written.`);
  return resp.json();
}

async function migrateFromKv(env: Env, kv: KVNamespace): Promise<void> {
  const status = await call(env, "/state/migrated");
  if (status?.migrated === true) return;
  const entries: [string, string][] = [];
  for (const prefix of DURABLE_STATE_PREFIXES) {
    let cursor: string | undefined;
    do {
      const page: any = await kv.list({ prefix, cursor });
      for (const k of page.keys || []) {
        const value = await kv.get(k.name);
        if (value !== null) entries.push([k.name, value]);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  // Batches stay well under request limits; only the last one sets the mark.
  const BATCH = 50;
  for (let i = 0; i < entries.length || i === 0; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const last = i + BATCH >= entries.length;
    await call(env, "/state/import", { entries: batch, mark_migrated: last });
    if (last) break;
  }
}

function ensureMigrated(env: Env, kv: KVNamespace): Promise<void> {
  let p = migratedIsolates.get(kv as unknown as object);
  if (!p) {
    p = migrateFromKv(env, kv).catch(e => { migratedIsolates.delete(kv as unknown as object); throw e; });
    migratedIsolates.set(kv as unknown as object, p);
  }
  return p;
}

/**
 * env with SYNC_STATE routed: per-account sync state goes to the Durable Object,
 * everything else to KV. Without the SYNC_LOCK binding, env is returned unchanged.
 */
export function withDurableAccountState(env: Env): Env {
  if (!env.SYNC_LOCK || !env.SYNC_STATE || (env.SYNC_STATE as any).__durableRouted) return env;
  const kv = env.SYNC_STATE;
  const routed = {
    __durableRouted: true,
    async get(key: string, ...rest: any[]): Promise<any> {
      if (!isDurableStateKey(key)) return (kv.get as any)(key, ...rest);
      await ensureMigrated(env, kv);
      const data = await call(env, `/state/get?key=${encodeURIComponent(key)}`);
      return typeof data?.value === "string" ? data.value : null;
    },
    async put(key: string, value: string, options?: any): Promise<void> {
      if (!isDurableStateKey(key)) return kv.put(key, value, options);
      await ensureMigrated(env, kv);
      await call(env, "/state/put", { key, value: String(value), ttl_seconds: options?.expirationTtl ?? null });
    },
    async delete(key: string): Promise<void> {
      if (!isDurableStateKey(key)) return kv.delete(key);
      await ensureMigrated(env, kv);
      await call(env, "/state/delete", { key });
    },
    list: (...args: any[]) => (kv.list as any)(...args),
    getWithMetadata: (...args: any[]) => (kv.getWithMetadata as any)(...args)
  };
  return { ...env, SYNC_STATE: routed as unknown as KVNamespace };
}
