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


    // Admin session epoch: every session cookie carries the epoch it was issued in and
    // is honored only while it matches. Bumping it signs out every browser at once.
    if (url.pathname === "/session/epoch" && request.method === "GET") {
      const epoch = await this.state.storage.get<number>("admin_session_epoch");
      return Response.json({ epoch: typeof epoch === "number" ? epoch : 0 });
    }
    if (url.pathname === "/session/epoch/bump" && request.method === "POST") {
      const epoch = await this.state.storage.transaction(async txn => {
        const current = await txn.get<number>("admin_session_epoch");
        const next = (typeof current === "number" ? current : 0) + 1;
        await txn.put("admin_session_epoch", next);
        return next;
      });
      return Response.json({ epoch });
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
