import { SYNC_LOCK_TTL_SECONDS } from "./lock";

// One strongly-consistent Durable Object owns both the global financial-write
// mutex and the small bounded diagnostic histories. KV read/modify/write is not
// atomic; these append operations use a storage transaction so concurrent syncs
// and webhooks cannot overwrite one another's history entries.
const HISTORY_LIMITS: Record<string, number> = {
  event_log: 200,
  webhook_history: 20
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
        const merged = [...body.items, ...existing].slice(0, limit);
        await txn.put(`history:${key}`, merged);
        return merged.length;
      });
      return Response.json({ ok: true, count });
    }

    if (url.pathname === "/history/get" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!HISTORY_LIMITS[key]) return Response.json({ error: "invalid history key" }, { status: 400 });
      const stored = await this.state.storage.get<unknown[]>(`history:${key}`);
      return Response.json({ items: Array.isArray(stored) ? stored : null });
    }

    const held = await this.state.storage.get<{ id: string; at: number }>("lock");
    const live = !!held && now - held.at <= ttlMs;

    if (url.pathname === "/acquire" && request.method === "POST") {
      if (live) return Response.json({ acquired: false, held_since: held!.at });
      const id = crypto.randomUUID();
      await this.state.storage.put("lock", { id, at: now });
      return Response.json({ acquired: true, id, stole_expired: !!held });
    }
    const id = url.searchParams.get("id") || "";
    if (url.pathname === "/renew" && request.method === "POST") {
      if (!held || held.id !== id) return Response.json({ renewed: false });
      await this.state.storage.put("lock", { id, at: now });
      return Response.json({ renewed: true });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      if (!held || held.id !== id) return Response.json({ released: false });
      await this.state.storage.delete("lock");
      return Response.json({ released: true });
    }
    return new Response("not found", { status: 404 });
  }
}
