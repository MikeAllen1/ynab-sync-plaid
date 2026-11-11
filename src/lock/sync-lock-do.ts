import { SYNC_LOCK_TTL_SECONDS } from "./lock";

// ---------- Worker entrypoints ----------

// ================= SyncLock Durable Object (atomic sync mutex) =================
//
// A single-threaded actor that serializes lock acquisition. Because a Durable
// Object processes one request at a time, "is it locked? if not, lock it" is
// atomic here in a way it can never be across two KV operations. SQLite-backed
// storage survives instance eviction between acquire and release. A TTL guards
// against a crashed run holding the lock forever: if the holder is older than
// the TTL, a new acquire steals it.
export class SyncLock {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // Lock record: { id, at }. `id` is the holder's token; only that token can renew
  // or release it, so a run that outlived the TTL can never free a newer holder.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const ttlMs = SYNC_LOCK_TTL_SECONDS * 1000;
    const held = await this.state.storage.get<{ id: string; at: number }>("lock");
    const live = !!held && now - held.at <= ttlMs;

    if (url.pathname === "/acquire") {
      if (live) return Response.json({ acquired: false, held_since: held!.at });
      const id = crypto.randomUUID();
      await this.state.storage.put("lock", { id, at: now });
      return Response.json({ acquired: true, id, stole_expired: !!held });
    }
    const id = url.searchParams.get("id") || "";
    if (url.pathname === "/renew") {
      if (!held || held.id !== id) return Response.json({ renewed: false });
      await this.state.storage.put("lock", { id, at: now });
      return Response.json({ renewed: true });
    }
    if (url.pathname === "/release") {
      if (!held || held.id !== id) return Response.json({ released: false });
      await this.state.storage.delete("lock");
      return Response.json({ released: true });
    }
    return new Response("not found", { status: 404 });
  }
}
