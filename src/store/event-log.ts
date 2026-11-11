import { Env } from "../types";

export const EVENT_LOG_KV_KEY = "event_log";
export const EVENT_LOG_MAX = 200;

export interface LogEvent {
  ts: string;
  account: string;
  action: string;
  transaction_id?: string;
  import_id?: string;
  amount?: number;
  detail?: string;
}

export function logEvent(sink: LogEvent[] | undefined, e: Omit<LogEvent, "ts">): void {
  if (!sink) return;
  sink.push({ ts: new Date().toISOString(), ...e });
}

async function legacyEvents(env: Env): Promise<LogEvent[]> {
  try {
    const raw = await env.SYNC_STATE.get(EVENT_LOG_KV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, EVENT_LOG_MAX) : [];
  } catch {
    return [];
  }
}

export async function flushEventLog(env: Env, events: LogEvent[]): Promise<void> {
  if (!events || events.length === 0) return;
  if (!env.SYNC_LOCK) throw new Error("SYNC_LOCK is required for atomic event history writes");
  // Seed the Durable Object from the legacy KV value on its first append. The
  // Durable Object transaction decides which concurrent caller initializes it.
  const initial = await legacyEvents(env);
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
  const response = await stub.fetch("https://sync-lock/history/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: EVENT_LOG_KV_KEY, items: events.slice(0, EVENT_LOG_MAX), initial })
  });
  if (!response.ok) throw new Error(`Atomic event history append failed (${response.status})`);
}

export async function getEventLog(env: Env): Promise<LogEvent[]> {
  if (env.SYNC_LOCK) {
    try {
      const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName("global"));
      const response = await stub.fetch(`https://sync-lock/history/get?key=${EVENT_LOG_KV_KEY}`);
      if (response.ok) {
        const data: any = await response.json();
        if (Array.isArray(data.items)) return data.items;
      }
    } catch {
      // Fall back to the legacy copy for read-only dashboard availability.
    }
  }
  return legacyEvents(env);
}
