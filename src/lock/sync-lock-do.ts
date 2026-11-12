import { SYNC_LOCK_TTL_SECONDS } from "./lock";
import { isDurableStateKey } from "../store/durable-state";

// One strongly-consistent Durable Object owns both the global financial-write
// mutex and the small bounded diagnostic histories. KV read/modify/write is not
// atomic; these append operations use a storage transaction so concurrent syncs
// and webhooks cannot overwrite one another's history entries.
export const AUTH_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_FAILS_PER_IP = 10;
export const AUTH_FAILS_GLOBAL = 50;

const HISTORY_LIMITS: Record<string, number> = {
  event_log: 200,
  webhook_history: 20,
  undo_log: 10
};

export class SyncLock {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const ttlMs = SYNC_LOCK_TTL_SECONDS * 1000;

    if (url.pathname === "/webhook/release" && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch {
        return Response.json({ error: "invalid webhook receipt" }, { status: 400 });
      }
      const digest = String(body?.digest || "");
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        return Response.json({ error: "invalid webhook digest" }, { status: 400 });
      }
      await this.state.storage.delete(`webhook_receipt:${digest}`);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/webhook/claim" && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch {
        return Response.json({ error: "invalid webhook receipt" }, { status: 400 });
      }
      const digest = String(body?.digest || "");
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        return Response.json({ error: "invalid webhook digest" }, { status: 400 });
      }
      const ttl = Math.max(60, Math.min(3600, Number(body?.ttl_seconds) || 600));
      const claimed = await this.state.storage.transaction(async txn => {
        const receipts = await txn.list<number>({ prefix: "webhook_receipt:", limit: 1000 });
        for (const [key, expiresAt] of receipts) {
          if (typeof expiresAt !== "number" || expiresAt <= now) await txn.delete(key);
        }
        const key = `webhook_receipt:${digest}`;
        const prior = await txn.get<number>(key);
        if (typeof prior === "number" && prior > now) return false;
        await txn.put(key, now + ttl * 1000);
        return true;
      });
      return Response.json({ ok: true, claimed, duplicate: !claimed });
    }

    if (url.pathname === "/history/append" && request.method === "POST") {
      let body: any;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 256 * 1024) {
          return Response.json({ error: "history payload too large" }, { status: 413 });
        }
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid history payload" }, { status: 400 });
      }
      const key = String(body?.key || "");
      const limit = HISTORY_LIMITS[key];
      if (!limit || !Array.isArray(body?.items) || !Array.isArray(body?.initial || [])) {
        return Response.json({ error: "invalid history append request" }, { status: 400 });
      }
      if (body.items.length > limit || (body.initial || []).length > limit) {
        return Response.json({ error: "history batch too large" }, { status: 400 });
      }
      const count = await this.state.storage.transaction(async txn => {
        const stored = await txn.get<unknown[]>(`history:${key}`);
        const existing = Array.isArray(stored)
          ? stored
          : (Array.isArray(body.initial) ? body.initial : []);
        let merged: any[];
        if (key === "undo_log") {
          merged = Array.isArray(existing) ? [...existing] : [];
          for (const incoming of body.items) {
            const at = incoming?.run_id ? merged.findIndex((entry: any) => entry?.run_id === incoming.run_id) : -1;
            if (at >= 0) {
              const prior = merged[at];
              merged[at] = { ...prior, items: [...(Array.isArray(prior.items) ? prior.items : []), ...(Array.isArray(incoming.items) ? incoming.items : [])] };
              merged[at].count = merged[at].items.length;
            } else merged.unshift(incoming);
          }
          merged = merged.slice(0, limit);
        } else merged = [...body.items, ...existing].slice(0, limit);
        await txn.put(`history:${key}`, merged);
        return merged.length;
      });
      return Response.json({ ok: true, count });
    }

    if (url.pathname === "/history/replace" && request.method === "POST") {
      let body: any;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 256 * 1024) return Response.json({ error: "history payload too large" }, { status: 413 });
        body = JSON.parse(raw);
      } catch { return Response.json({ error: "invalid history payload" }, { status: 400 }); }
      const key = String(body?.key || "");
      const limit = HISTORY_LIMITS[key];
      if (!limit || !Array.isArray(body?.items) || body.items.length > limit) return Response.json({ error: "invalid history replacement" }, { status: 400 });
      await this.state.storage.transaction(async txn => { await txn.put(`history:${key}`, body.items); });
      return Response.json({ ok: true, count: body.items.length });
    }

    if (url.pathname === "/history/get" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!HISTORY_LIMITS[key]) return Response.json({ error: "invalid history key" }, { status: 400 });
      const stored = await this.state.storage.get<unknown[]>(`history:${key}`);
      return Response.json({ items: Array.isArray(stored) ? stored : null });
    }


    // Per-account sync state (see store/durable-state.ts). Values are strings, stored
    // under "state:<key>" with an optional expiry; only allowlisted prefixes are taken.
    if (url.pathname.startsWith("/state/")) {
      const okKey = (k: unknown) => typeof k === "string" && k.length <= 512 && isDurableStateKey(k);
      const live = (v: any) => v && typeof v.value === "string" && (!v.expires_at || v.expires_at > now);
      if (url.pathname === "/state/migrated" && request.method === "GET") {
        return Response.json({ migrated: (await this.state.storage.get("state_migrated")) === true });
      }
      if (url.pathname === "/state/get" && request.method === "GET") {
        const key = url.searchParams.get("key") || "";
        if (!okKey(key)) return Response.json({ error: "invalid state key" }, { status: 400 });
        const v: any = await this.state.storage.get(`state:${key}`);
        return Response.json({ value: live(v) ? v.value : null });
      }
      let body: any;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 1900 * 1024) return Response.json({ error: "state payload too large" }, { status: 413 });
        body = JSON.parse(raw);
      } catch { return Response.json({ error: "invalid state payload" }, { status: 400 }); }
      if (url.pathname === "/state/put" && request.method === "POST") {
        if (!okKey(body?.key) || typeof body?.value !== "string") return Response.json({ error: "invalid state put" }, { status: 400 });
        const ttl = Number(body.ttl_seconds);
        await this.state.storage.put(`state:${body.key}`, { value: body.value, expires_at: Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : null });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/state/delete" && request.method === "POST") {
        if (!okKey(body?.key)) return Response.json({ error: "invalid state delete" }, { status: 400 });
        await this.state.storage.delete(`state:${body.key}`);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/state/import" && request.method === "POST") {
        const entries = Array.isArray(body?.entries) ? body.entries : null;
        if (!entries || entries.length > 200) return Response.json({ error: "invalid state import" }, { status: 400 });
        const result = await this.state.storage.transaction(async txn => {
          // Once migrated, the Durable Object is the only source: a late import from a
          // slower isolate must not bring back values a run has since changed.
          if ((await txn.get("state_migrated")) === true) return { imported: 0, already_migrated: true };
          let imported = 0;
          for (const e of entries) {
            if (!Array.isArray(e) || !okKey(e[0]) || typeof e[1] !== "string") continue;
            if ((await txn.get(`state:${e[0]}`)) !== undefined) continue;
            await txn.put(`state:${e[0]}`, { value: e[1], expires_at: null });
            imported++;
          }
          if (body.mark_migrated === true) await txn.put("state_migrated", true);
          return { imported, already_migrated: false };
        });
        return Response.json({ ok: true, ...result });
      }
      return new Response("not found", { status: 404 });
    }

    // Failed admin-token attempts, per client IP and globally, in a rolling window.
    // "/auth/check" says whether a key is currently throttled; "/auth/fail" records a
    // failure. Successful logins don't reset anything: the window simply rolls.
    if ((url.pathname === "/auth/check" || url.pathname === "/auth/fail") && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch { return Response.json({ error: "invalid auth request" }, { status: 400 }); }
      const keys = (Array.isArray(body?.keys) ? body.keys : []).map((k: unknown) => String(k)).filter((k: string) => /^[a-z]+:[\w.:-]{1,80}$/.test(k)).slice(0, 4);
      const limits: Record<string, number> = { ip: AUTH_FAILS_PER_IP, global: AUTH_FAILS_GLOBAL };
      const result = await this.state.storage.transaction(async txn => {
        let retryAfterMs = 0;
        for (const key of keys) {
          const stored = await txn.get<number[]>(`auth_fail:${key}`);
          const live = (Array.isArray(stored) ? stored : []).filter(ts => Number.isFinite(ts) && now - ts < AUTH_WINDOW_MS);
          if (url.pathname === "/auth/fail") live.push(now);
          if (live.length) await txn.put(`auth_fail:${key}`, live.slice(-200)); else await txn.delete(`auth_fail:${key}`);
          const limit = limits[key.split(":")[0]] ?? AUTH_FAILS_PER_IP;
          if (live.length >= limit) retryAfterMs = Math.max(retryAfterMs, live[live.length - limit] + AUTH_WINDOW_MS - now);
        }
        return { blocked: retryAfterMs > 0, retry_after_seconds: Math.ceil(retryAfterMs / 1000) };
      });
      return Response.json(result);
    }

    if (url.pathname === "/ynab-rate/reserve" && request.method === "POST") {
      // YNAB documents a 200-request/hour token limit. Keep this worker below it
      // so dashboard/manual API use has headroom. This is a rolling window, not a
      // fixed clock bucket, and the DO transaction makes reservations atomic.
      const windowMs = 60 * 60 * 1000;
      const limit = 180;
      const result = await this.state.storage.transaction(async txn => {
        const stored = await txn.get<number[]>("ynab-rate:timestamps");
        const live = (Array.isArray(stored) ? stored : []).filter(ts => Number.isFinite(ts) && now - ts < windowMs);
        if (live.length >= limit) {
          await txn.put("ynab-rate:timestamps", live);
          return { reserved: false, retry_after_ms: Math.max(0, live[0] + windowMs - now) };
        }
        live.push(now);
        await txn.put("ynab-rate:timestamps", live);
        return { reserved: true, remaining: limit - live.length };
      });
      return Response.json(result, { status: result.reserved ? 200 : 429 });
    }

    if (url.pathname === "/acquire" && request.method === "POST") {
      const result = await this.state.storage.transaction(async txn => {
        const held = await txn.get<{ id: string; at: number }>("lock");
        const live = !!held && now - held.at <= ttlMs;
        if (live) return { acquired: false, held_since: held!.at };
        const id = crypto.randomUUID();
        await txn.put("lock", { id, at: now });
        return { acquired: true, id, stole_expired: !!held };
      });
      return Response.json(result);
    }
    const id = url.searchParams.get("id") || "";
    if (url.pathname === "/renew" && request.method === "POST") {
      const renewed = await this.state.storage.transaction(async txn => {
        const held = await txn.get<{ id: string; at: number }>("lock");
        if (!held || held.id !== id) return false;
        await txn.put("lock", { id, at: now });
        return true;
      });
      return Response.json({ renewed });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const released = await this.state.storage.transaction(async txn => {
        const held = await txn.get<{ id: string; at: number }>("lock");
        if (!held || held.id !== id) return false;
        await txn.delete("lock");
        return true;
      });
      return Response.json({ released });
    }
    return new Response("not found", { status: 404 });
  }
}
