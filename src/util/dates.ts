import { DEFAULT_TIMEZONE } from "../constants";
import { isWorkerPendingRow } from "../sync/engine";
import { Env, YNABExistingTransaction } from "../types";

export function isStalePendingCandidate(t: YNABExistingTransaction, plaidPendingImportIds: Set<string>, staleDays: number, todayStr: string): boolean {
  const importId = String(t.import_id || "");
  if (!isWorkerPendingRow(t)) return false;
  if (plaidPendingImportIds.has(importId)) return false;
  return calendarDaysBetween(t.date, todayStr) >= staleDays;
}

// Returns today's calendar date (YYYY-MM-DD) in the configured timezone. Using
// the local date avoids a UTC "now" flipping the day boundary in the evening
// (e.g. 7pm Central is already "tomorrow" in UTC), which could age a pending
// transaction a day early or late.
// The calendar date of a timestamp in your time zone.
export function dateInTimeZone(env: Env, iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE || DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function todayInTimeZone(env: Env): string {
  const tz = env.TIMEZONE || DEFAULT_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Whole-day difference between two YYYY-MM-DD strings. Both are anchored to UTC
// midnight so the subtraction is timezone-neutral and exact.
export function calendarDaysBetween(fromDateStr: string, toDateStr: string): number {
  const from = Date.parse(`${fromDateStr}T00:00:00Z`);
  const to = Date.parse(`${toDateStr}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor((to - from) / 86400000);
}
