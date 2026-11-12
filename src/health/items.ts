import { health, readJson } from "./status";
import { getRecentRawTransactionsDetailed, lookbackDate, plaidItemCached } from "../plaid/fetch";
import { getAuditedAccounts, isCreditCardAccount } from "../store/accounts";
import { flushEventLog, getEventLog } from "../store/event-log";
import { VERIFY_WINDOW_DAYS, expectedPendingImportId, isWorkerPendingRow, lifecycleKey } from "../sync/engine";
import { daysApart, getCcEpoch } from "../sync/matching";
import { roundMoney } from "../sync/transfers";
import { AccountConfig, Env, ItemHealth, PlaidTransaction, YNABExistingTransaction } from "../types";
import { ynabGetAccountTransactions } from "../ynab/client";

// ---------- Item health ----------
//
// Groups accounts by Plaid Item (one bank login can back several accounts, e.g.
// a checking account and a card at the same bank share one Item). Calls /item/get per Item to surface
// reauth needs BEFORE a sync fails. Stored in KV under "item_health".

export const ITEM_HEALTH_KV_KEY = "item_health";
export const ITEM_HEALTH_MIN_INTERVAL_MINUTES = 6 * 60; // every ~6h

// ---------- Stuck pending rows: saved explanations ----------
//
// Every hourly health check traces the worker's pending rows. A row counts as stuck
// when the bank has moved on (Plaid has a posted version, or no longer lists it, or
// YNAB refused the flip) but the row is still pending in YNAB after the sync that
// should have moved it. The first sighting is saved with everything Plaid said at the
// time; it stays (marked resolved) after the row is fixed, by the worker or by you.
export const STUCK_LOG_KEY = "stuck_pending_log";
export const STUCK_LOG_MAX = 50;

export interface StuckEntry {
  account: string; import_id: string; date: string; payee: string; amount: number;
  first_seen: string; last_seen: string; resolved_at: string | null;
  verdict: string; failure_detail: string | null;
  plaid_pending: any; plaid_posted_linked: any; unlinked_posted_lookalikes: any[];
  plaid_last_bank_update: string | null;
  sightings: number;   // syncs it has survived while stuck; 2 means a sync ran and didn't fix it
  sync_at?: string | null;   // the account's last sync time when it was last counted
}

export async function captureStuckPending(env: Env, acct: AccountConfig, hasPending: boolean, register?: YNABExistingTransaction[] | null): Promise<void> {
  const log: StuckEntry[] = await readJson(env, STUCK_LOG_KEY, []);
  const open = log.filter(e => e.account === acct.nickname && !e.resolved_at);
  if (!hasPending && open.length === 0) return; // nothing to trace or resolve: no API calls
  const now = new Date().toISOString();
  let changed = false;
  const trace = hasPending ? await tracePendingRows(env, acct, register) : { rows: [], plaid_last_bank_update: null };
  // A sighting only counts when a sync of this account ran since the last one. Two
  // health checks in a row (the hourly one and a Re-check) with no sync between are
  // one sighting: the charge may simply have posted since the last sync.
  const lastSync = (await env.SYNC_STATE.get(`last_account_sync:${acct.plaid_account_id}`)) || null;
  const stillPendingIds = new Set<string>((trace.rows || []).map((r: any) => r.import_id));
  const newlyStuck: StuckEntry[] = [];
  for (const r of (trace.rows || [])) {
    if (r.plaid_pending) continue; // Plaid still says pending: nothing is stuck
    const existing = log.find(e => e.account === acct.nickname && e.import_id === r.import_id && !e.resolved_at);
    if (existing) {
      existing.last_seen = now; existing.verdict = r.verdict;
      if (r.failure_detail) existing.failure_detail = r.failure_detail;
      if (lastSync && lastSync !== (existing.sync_at || null)) {
        existing.sightings = (existing.sightings || 1) + 1;
        existing.sync_at = lastSync;
        // Announce it once a sync has run and still left it pending, so a charge that
        // posted between a sync and its health check isn't a false alarm.
        if (existing.sightings === 2) newlyStuck.push(existing);
      }
      changed = true; continue;
    }
    const entry: StuckEntry = {
      account: acct.nickname, import_id: r.import_id, date: r.date, payee: r.payee, amount: r.amount,
      first_seen: now, last_seen: now, resolved_at: null, verdict: r.verdict, failure_detail: r.failure_detail || null,
      plaid_pending: r.plaid_pending, plaid_posted_linked: r.plaid_posted_linked, unlinked_posted_lookalikes: r.unlinked_posted_lookalikes || [],
      plaid_last_bank_update: trace.plaid_last_bank_update || null, sightings: 1, sync_at: lastSync
    };
    log.unshift(entry); changed = true;
  }
  // Rows that are no longer pending in YNAB (flipped by the worker, or fixed by you).
  for (const e of open) {
    if (!stillPendingIds.has(e.import_id)) { e.resolved_at = now; changed = true; }
  }
  if (!changed) return;
  const cutoff = Date.now() - 30 * 86400000;
  const kept = log.filter(e => !e.resolved_at || Date.parse(e.resolved_at) > cutoff).slice(0, STUCK_LOG_MAX);
  await env.SYNC_STATE.put(STUCK_LOG_KEY, JSON.stringify(kept));
  if (newlyStuck.length) {
    await flushEventLog(env, newlyStuck.map(e => ({
      ts: now, account: acct.nickname, action: "stuck_pending", import_id: e.import_id, amount: Math.round(e.amount * 1000),
      detail: `${e.payee} $${Math.abs(e.amount).toFixed(2)} on ${e.date}: still pending in YNAB. ${e.verdict} Details saved under Recovery.`
    })));
  }
}

export async function tracePendingRows(env: Env, acct: AccountConfig, registerIn?: YNABExistingTransaction[] | null): Promise<any> {
  const pid = acct.plaid_account_id;
  const epoch = isCreditCardAccount(acct) ? await getCcEpoch(env, pid) : "";
  const register = registerIn || await ynabGetAccountTransactions(env, acct.ynab_account_id, lookbackDate(env));
  const w = await getRecentRawTransactionsDetailed(env, acct, VERIFY_WINDOW_DAYS + 5, 500);
  const plaid = w.transactions.filter(t => t.account_id === pid);
  let lastBankUpdate: string | null = null;
  try {
    const item = await plaidItemCached(env, acct.plaid_access_token);
    lastBankUpdate = item.status?.transactions?.last_successful_update || null;
  } catch { /* shown as unknown */ }
  const failed: Record<string, string> = await readJson(env, `update_failed:${pid}`, {});
  const failureText: Record<string, string> = {};
  for (const e of await getEventLog(env)) {
    if ((e.action === "update_failed" || e.action === "delete_failed") && e.transaction_id && !failureText[e.transaction_id]) failureText[e.transaction_id] = String(e.detail || "");
  }
  const byDerivedId = new Map<string, PlaidTransaction[]>();
  for (const t of plaid) {
    const id = expectedPendingImportId(acct, lifecycleKey(t), epoch);
    if (!byDerivedId.has(id)) byDerivedId.set(id, []);
    byDerivedId.get(id)!.push(t);
  }
  const pendingInPlaid = plaid.filter(t => t.pending);
  const rows = register.filter(r => r.cleared === "uncleared" && isWorkerPendingRow(r));
  const out = rows.map(r => {
    const linked = byDerivedId.get(String(r.import_id || "")) || [];
    const stillPending = linked.find(t => t.pending);
    const posted = linked.find(t => !t.pending);
    const milli = Number(r.amount || 0);
    const candidates = plaid.filter(t => !t.pending && !linked.includes(t) && Math.abs(Math.round(-t.amount * 1000) - milli) <= Math.max(5000, Math.abs(milli) * 0.25) && daysApart(t.date, r.date) <= 10)
      .map(t => ({ date: t.date, authorized_date: t.authorized_date, name: t.name, amount: roundMoney(-t.amount), days_after_pending: daysApart(t.date, r.date) }));
    let verdict: string;
    if (failed[r.id]) verdict = `The worker tried to mark this posted, but YNAB refused the change${failureText[r.id] ? ` (${failureText[r.id].replace(/^.*?: /, "").replace(/\. Fix it in YNAB.*$/, "")})` : ""}. Fix the row in YNAB (a split, say) or mark it cleared yourself.`;
    else if (stillPending) verdict = "Plaid still reports this charge as pending, so YNAB matches Plaid. The bank's app may already show it posted; Plaid hasn't caught up yet.";
    else if (posted) verdict = "Plaid has the posted version and it's linked to this row. The next sync should mark it posted; if it doesn't, check Activity for errors.";
    else if (candidates.length) verdict = "Plaid dropped the pending charge and has a posted charge that looks like it but isn't linked, so the worker didn't pair them automatically.";
    else verdict = "Plaid no longer lists this charge at all (pending or posted). It's removed once the worker can read the full 30 days of bank data.";
    return { date: r.date, payee: r.payee_name, amount: roundMoney(milli / 1000), import_id: r.import_id, verdict, failure_detail: failureText[r.id] || null, plaid_pending: stillPending ? { date: stillPending.date, name: stillPending.name, amount: roundMoney(-stillPending.amount) } : null, plaid_posted_linked: posted ? { date: posted.date, name: posted.name, amount: roundMoney(-posted.amount) } : null, unlinked_posted_lookalikes: candidates.slice(0, 5) };
  });
  return {
    ok: true, account: acct.nickname,
    plaid_last_bank_update: lastBankUpdate,
    plaid_pending_count: pendingInPlaid.length,
    plaid_pending: pendingInPlaid.map(t => ({ date: t.date, name: t.name, amount: roundMoney(-t.amount) })),
    ynab_uncleared_worker_rows: out.length,
    window_truncated: w.truncated,
    rows: out
  };
}

export async function getItemHealth(env: Env): Promise<Record<string, ItemHealth>> {
  try {
    const raw = await env.SYNC_STATE.get(ITEM_HEALTH_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

export async function putItemHealth(env: Env, health: Record<string, ItemHealth>): Promise<void> {
  await env.SYNC_STATE.put(ITEM_HEALTH_KV_KEY, JSON.stringify(health));
}

// Maps a Plaid error into a friendly health status. Reauth-class errors are the
// ones the user must act on; everything else is a transient/unknown error.
// Plaid normally refreshes a bank several times a day; this long without new data
// (weekends included) means the connection has quietly stopped.
export const BANK_DATA_STALE_DAYS = 3;

/**
 * Pull Plaid's error_code out of a plaidCall error. plaidCall reports
 * `Plaid /path failed: {"error_code":"ITEM_LOGIN_REQUIRED",...}`; older messages used
 * `...: ITEM_LOGIN_REQUIRED - message`. Anything else is UNKNOWN.
 */
export function plaidErrorCode(message: string): string {
  const json = message.match(/"error_code"\s*:\s*"([A-Z0-9_]+)"/);
  if (json) return json[1];
  const legacy = message.match(/:\s*([A-Z][A-Z0-9_]+)\s*-/);
  return legacy ? legacy[1] : "UNKNOWN";
}

export function itemStatusFromError(errorCode: string): "needs_reauth" | "error" {
  const reauth = ["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN", "INVALID_CREDENTIALS", "ITEM_LOCKED", "USER_PERMISSION_REVOKED", "PENDING_EXPIRATION"];
  return reauth.includes(errorCode) ? "needs_reauth" : "error";
}

// Runs /item/get for each distinct Plaid Item and records health. force=true
// bypasses the once-per-interval throttle (used by the manual dashboard button).
export async function runItemHealthCheck(env: Env, force = false): Promise<Record<string, ItemHealth>> {
  const existing = await getItemHealth(env);

  const accounts = await getAuditedAccounts(env);

  if (!force) {
    const values = Object.values(existing);
    const allFresh = values.length > 0 && values.every(h => {
      if (!h.last_check) return false;
      const age = (Date.now() - new Date(h.last_check).getTime()) / 60000;
      return age < ITEM_HEALTH_MIN_INTERVAL_MINUTES;
    });
    // A bank added (or removed) since the last check makes the stored report stale,
    // so a new connection is monitored right away rather than up to 6 hours later.
    const covered = new Set(values.flatMap(h => h.nicknames || []));
    const sameAccounts = accounts.length === covered.size && accounts.every(a => covered.has(a.nickname));
    // Older versions could key an entry on the access token itself; replace those now.
    const tokenKeyed = Object.keys(existing).some(k => k.startsWith("access-"));
    if (allFresh && sameAccounts && !tokenKeyed) return existing;
  }

  // Group accounts by Item. Prefer explicit item_id; else group by shared token.
  // The token is only a grouping key in memory; it is never stored or returned.
  const groups = new Map<string, { token: string; institution: string; nicknames: string[]; itemId: string }>();
  for (const a of accounts) {
    const key = a.item_id || a.plaid_access_token;
    if (!groups.has(key)) {
      groups.set(key, { token: a.plaid_access_token, institution: a.institution || "", nicknames: [], itemId: a.item_id || "" });
    }
    groups.get(key)!.nicknames.push(a.nickname);
  }

  const health: Record<string, ItemHealth> = {};
  for (const [, g] of groups) {
    const now = new Date().toISOString();
    const fallbackId = g.itemId || `login:${g.nicknames.join("+")}`;
    try {
      const resp = await plaidItemCached(env, g.token);
      const itemId = (resp.item && resp.item.item_id) || fallbackId;
      const itemError = resp.item && resp.item.error;
      // Plaid can quietly stop getting data from a bank without reporting an error.
      const lastUpdate: string | null = resp.status?.transactions?.last_successful_update || null;
      const updateAgeDays = lastUpdate ? (Date.now() - Date.parse(lastUpdate)) / 86400000 : 0;
      const expiring = await env.SYNC_STATE.get(`item_pending_expiration:${itemId}`);
      if (itemError && itemError.error_code) {
        health[itemId] = {
          item_id: itemId, institution: g.institution, nicknames: g.nicknames,
          status: itemStatusFromError(itemError.error_code), last_check: now, error: itemError.error_code, last_bank_update: lastUpdate
        };
      } else if (expiring) {
        health[itemId] = {
          item_id: itemId, institution: g.institution, nicknames: g.nicknames,
          status: "needs_reauth", last_check: now, error: "PENDING_EXPIRATION", last_bank_update: lastUpdate
        };
      } else if (updateAgeDays > BANK_DATA_STALE_DAYS) {
        health[itemId] = {
          item_id: itemId, institution: g.institution, nicknames: g.nicknames,
          status: "stale", last_check: now, error: "BANK_DATA_STALE", last_bank_update: lastUpdate
        };
      } else {
        health[itemId] = {
          item_id: itemId, institution: g.institution, nicknames: g.nicknames,
          status: "healthy", last_check: now, error: null, last_bank_update: lastUpdate
        };
      }
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      const code = plaidErrorCode(msg);
      const itemId = fallbackId;
      health[itemId] = {
        item_id: itemId, institution: g.institution, nicknames: g.nicknames,
        status: itemStatusFromError(code), last_check: now, error: code
      };
    }
  }

  // Alert on a HEALTHY -> UNHEALTHY transition (edge-triggered, so you get one email
  // when a connection dies, not one every cron tick while it stays down). Compares the
  // new status against the previously stored status per item.
  // An email that failed to send is retried on the next check (alert_failed).
  const newlyBroken: ItemHealth[] = [];
  for (const [itemId, h] of Object.entries(health)) {
    if (h.status === "needs_reauth" || h.status === "error" || h.status === "stale") {
      const prev = existing[itemId];
      const wasOk = !prev || prev.status === "healthy" || prev.status === "unknown";
      // A connection that was already flagged as a temporary problem and now needs
      // you to reconnect is news too: that is the email that asks you to act.
      const escalated = !!prev && h.status === "needs_reauth" && prev.status !== "needs_reauth";
      if (wasOk || escalated || prev?.alert_failed) newlyBroken.push(h);
    }
  }
  if (newlyBroken.length > 0) {
    try {
      await sendConnectionAlert(env, newlyBroken);
      if (await env.SYNC_STATE.get("last_alert_failure")) {
        const f = await readJson(env, "last_alert_failure", null);
        if (f?.kind === "email") await env.SYNC_STATE.delete("last_alert_failure");
      }
    } catch (e: any) {
      // Never let an alert failure block health persistence; remember it for retry.
      for (const h of newlyBroken) h.alert_failed = true;
      try { await env.SYNC_STATE.put("last_alert_failure", JSON.stringify({ ts: new Date().toISOString(), kind: "email", error: String(e?.message || e) })); } catch { /* ignore */ }
    }
  }

  // An email about a connection that has since recovered has nothing left to send:
  // once every connection is healthy again, the old failure is no longer news.
  if (newlyBroken.length === 0 && Object.values(health).every(h => h.status === "healthy")) {
    const f = await readJson(env, "last_alert_failure", null);
    if (f?.kind === "email") await env.SYNC_STATE.delete("last_alert_failure");
  }

  await putItemHealth(env, health);
  return health;
}

// Email an alert when a bank connection dies, via Resend. Requires two secrets:
//   RESEND_API_KEY  - from resend.com (free tier)
//   ALERT_EMAIL_TO  - the address to notify (your inbox)
// Optional: ALERT_EMAIL_FROM (defaults to Resend's onboarding sender, which works
// for sending to your own verified address without domain setup).
export async function sendConnectionAlert(env: Env, broken: ItemHealth[]): Promise<void> {
  const apiKey = (env as any).RESEND_API_KEY;
  const to = (env as any).ALERT_EMAIL_TO;
  if (!apiKey || !to) return; // not configured yet -> silently skip
  const from = (env as any).ALERT_EMAIL_FROM || "YNAB Sync <onboarding@resend.dev>";
  const origin = (env as any).WORKER_ORIGIN || "https://<your-worker>.workers.dev";

  const what = (h: ItemHealth) => h.status === "needs_reauth" ? "needs to be reconnected"
    : h.status === "stale" ? `hasn't sent new data since ${h.last_bank_update ? h.last_bank_update.slice(0, 10) : "a while"}`
    : "has a connection problem (may be temporary)";
  const lines = broken.map(h => {
    const bank = h.institution || h.nicknames.join(", ") || h.item_id;
    return `• ${bank} (${h.nicknames.join(", ")}): ${what(h)} [${h.error || h.status}]`;
  }).join("\n");
  const needsReauth = broken.some(h => h.status === "needs_reauth");

  const text =
    (needsReauth
      ? `A bank connection in your YNAB sync stopped working and needs to be reconnected.\n\n`
      : `A bank connection in your YNAB sync has a problem.\n\n`) +
    `${lines}\n\n` +
    (needsReauth
      ? `Reconnect it here (log in and click Reconnect):\n${origin}/setup\n\nUntil you reconnect, that account's balance in YNAB will be stale.`
      : `If it doesn't clear up within a day, reconnect it here:\n${origin}/setup`);

  const subject = broken.length === 1
    ? `⚠️ YNAB sync: ${broken[0].institution || broken[0].nicknames.join(", ")} ${needsReauth ? "needs reconnect" : "connection problem"}`
    : `⚠️ YNAB sync: ${broken.length} bank connections ${needsReauth ? "need attention" : "have problems"}`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
  // Resend answers 4xx when it refuses (unverified sender, a recipient the onboarding
  // sender can't reach). Report that instead of pretending the email went out.
  if (!resp.ok) {
    let detail = "";
    try { detail = await resp.text(); } catch { /* ignore */ }
    throw new Error(`Resend refused the email (${resp.status}): ${detail.slice(0, 300)}`);
  }
}
