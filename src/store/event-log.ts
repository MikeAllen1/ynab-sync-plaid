import { Env } from "../types";

// ---------- Structured event log ----------
//
// A lightweight append-only log of meaningful actions (pending imports, posted
// gap-fills, pending retirements, duplicate removals). Each sync collects events
// in memory and flushes them once at the end, so KV sees a single write per run.
// The log is a bounded ring buffer (newest first) for the dashboard's activity
// feed and for after-the-fact debugging without scraping wrangler tail.

export const EVENT_LOG_KV_KEY = "event_log";
export const EVENT_LOG_MAX = 200;

export interface LogEvent {
  ts: string;
  account: string;
  action: string;        // e.g. "pending_import", "posted_gapfill", "pending_retire", "duplicate_remove"
  transaction_id?: string;
  import_id?: string;
  amount?: number;       // milliunits, as stored in YNAB
  detail?: string;
}

// In-run collector. Pass an array into the sync, push events, flush once at end.
export function logEvent(sink: LogEvent[] | undefined, e: Omit<LogEvent, "ts">): void {
  if (!sink) return;
  sink.push({ ts: new Date().toISOString(), ...e });
}

export async function flushEventLog(env: Env, events: LogEvent[]): Promise<void> {
  if (!events || events.length === 0) return;
  let existing: LogEvent[] = [];
  try {
    const raw = await env.SYNC_STATE.get(EVENT_LOG_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    }
  } catch {
    existing = [];
  }
  // Newest first, bounded.
  const merged = events.concat(existing).slice(0, EVENT_LOG_MAX);
  await env.SYNC_STATE.put(EVENT_LOG_KV_KEY, JSON.stringify(merged));
}

export async function getEventLog(env: Env): Promise<LogEvent[]> {
  try {
    const raw = await env.SYNC_STATE.get(EVENT_LOG_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}
