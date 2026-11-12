import { SYNC_LOCK_TTL_SECONDS } from "./lock";

// One strongly-consistent Durable Object owns both the global financial-write
// mutex and the small bounded diagnostic histories. KV read/modify/write is not
// atomic; these append operations use a storage transaction so concurrent syncs
// and webhooks cannot overwrite one another's history entries.
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


    if (url.pathname === "/readiness" && request.method === "GET") {
      const key = "__security_readiness_probe";
      const storageOk = await this.state.storage.transaction(async txn => {
        await txn.put(key, now);
        const value = await txn.get<number>(key);
        await txn.delete(key);
        return value === now;
      });
      return Response.json({ ok: storageOk, class: "SyncLock", storage: "available" }, { status: storageOk ? 200 : 503 });
    }

    if (url.pathname.startsWith("/session/") && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch { return Response.json({ error: "invalid session request" }, { status: 400 }); }
      const fingerprint = String(body?.fingerprint || "");
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return Response.json({ error: "invalid session id" }, { status: 400 });
      const key = `session:${fingerprint}`;
      if (url.pathname === "/session/create") {
        const expiresAt = Number(body?.expiresAt);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 3600000) {
          return Response.json({ error: "invalid session expiry" }, { status: 400 });
        }
        await this.state.storage.put(key, { expiresAt });
        return Response.json({ created: true });
      }
      if (url.pathname === "/session/validate") {
        const record = await this.state.storage.get<{ expiresAt: number }>(key);
        const valid = !!record && Number.isSafeInteger(record.expiresAt) && record.expiresAt > now;
        if (record && !valid) await this.state.storage.delete(key);
        return Response.json({ valid });
      }
      if (url.pathname === "/session/revoke") {
        await this.state.storage.delete(key);
        return Response.json({ revoked: true });
      }
    }

    if (url.pathname === "/webhook/key-read" && request.method === "POST") {
      const allowed = await this.state.storage.transaction(async txn => {
        const key = "webhook:key-read-window";
        const stored = await txn.get<{ start: number; count: number }>(key);
        const window = stored && now - stored.start < 600000
          ? stored
          : { start: now, count: 0 };
        if (window.count >= 1000) return false;
        window.count++;
        await txn.put(key, window);
        return true;
      });
      return Response.json({ allowed });
    }

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
        return Response.json({ error: "invalid webhook claim" }, { status: 400 });
      }
      const digest = String(body?.digest || "");
      const fingerprint = String(body?.fingerprint || "");
      if (/^[a-f0-9]{64}$/.test(digest)) {
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
      if (/^[a-f0-9]{64}$/.test(fingerprint)) {
        const claimed = await this.state.storage.transaction(async txn => {
          const key = "webhook:seen";
          const stored = await txn.get<Record<string, number>>(key);
          const seen = stored && typeof stored === "object" ? stored : {};
          for (const [hash, at] of Object.entries(seen)) {
            if (typeof at !== "number" || now - at >= 600000) delete seen[hash];
          }
          if (seen[fingerprint]) {
            await txn.put(key, seen);
            return false;
          }
          const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 999);
          const bounded = Object.fromEntries(entries);
          bounded[fingerprint] = now;
          await txn.put(key, bounded);
          return true;
        });
        return Response.json({ claimed, duplicate: !claimed });
      }
      return Response.json({ error: "invalid webhook digest or fingerprint" }, { status: 400 });
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
          merged = [...existing];
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

    if (url.pathname === "/ynab-rate/reserve" && request.method === "POST") {
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
