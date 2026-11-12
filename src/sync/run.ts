import { runAccountAudit } from "../audit/audit";
import { AUDIT_DAYS, AUDIT_MIN_INTERVAL_MINUTES, DEFAULT_SYNC_FREQUENCY_MINUTES, STALE_PENDING_DAYS, WORKER_VERSION } from "../constants";
import { getItemHealth } from "../health/items";
import { prettyNickname, readJson } from "../health/status";
import { LockHandle, acquireSyncLock, appendSkippedIncomeHistory, dropLease, holdLease, isSyncEnabled, lastLockUnreachable, releaseSyncLock, renewSyncLock } from "../lock/lock";
import { getSkipRules } from "../rules/skip-rules";
import { CONFIG_UNREADABLE, getAccountAutomationSettings, getAccounts, settingForAccount } from "../store/accounts";
import { LogEvent, flushEventLog } from "../store/event-log";
import { bootstrap, bootstrapPlan, syncAccountEngine } from "./engine";
import { AccountAutomationSetting, AccountConfig, Env, SkippedIncomeRecord, SyncOptions } from "../types";
import { friendlyErrorMessage } from "../util/errors";

// ---------- Core sync logic ----------

export async function syncAll(env: Env, options: SyncOptions = {}): Promise<any> {
  const syncEnabled = await isSyncEnabled(env);

  // The global switch stops every writing run. Only a dry run (read-only preview)
  // may look past it.
  if (!syncEnabled && !options.dryRun) {
    return {
      ts: new Date().toISOString(),
      status: "paused",
      trigger: options.trigger || "unknown",
      dry_run: false,
      note: "Global sync is paused. Nothing was read or written.",
      results: []
    };
  }

  // Dry runs write nothing (YNAB or KV), so they take no lock and are never blocked.
  if (options.dryRun) return await runSyncAll(env, options, null);

  const lock = await acquireSyncLock(env);
  if (!lock) {
    const unreachable = lastLockUnreachable;
    if (unreachable) {
      // Not "busy": nothing can sync until the lock service is back. Record it so the
      // dashboard and alerts show an error instead of quietly skipping every run.
      const errors = [{ account: "all", status: "error", error: "SYNC_LOCK unreachable", friendly_error: "The sync lock service (SYNC_LOCK Durable Object) couldn't be reached, so no account was synced. Check the Durable Object binding in Cloudflare." }];
      await env.SYNC_STATE.put("last_error", JSON.stringify({ ts: new Date().toISOString(), errors }));
      await maybeSendHealthAlert(env, { trigger: options.trigger || "unknown" }, errors);
    } else if (options.webhookItemId) {
      // A webhook that arrives mid-sync would otherwise be dropped. Mark its bank's
      // accounts as due so the next cron tick syncs them instead of waiting a full
      // interval.
      await markItemDue(env, options.webhookItemId);
    }
    return {
      ts: new Date().toISOString(),
      status: unreachable ? "lock_unavailable" : "skipped_locked",
      trigger: options.trigger || "unknown",
      dry_run: false,
      note: unreachable
        ? "The sync lock service couldn't be reached, so nothing was synced. Check the SYNC_LOCK Durable Object binding."
        : "Another sync or change is in progress. Skipped to avoid overlapping writes; the next scheduled run will pick up.",
      results: []
    };
  }
  holdLease(env, lock);
  try {
    return await runSyncAll(env, options, lock);
  } finally {
    dropLease(lock);
    await releaseSyncLock(env, lock);
  }
}

// Clear the "last synced" stamps of a bank's accounts so the next cron tick treats
// them as due.
export async function markItemDue(env: Env, itemId: string): Promise<void> {
  const accounts = await getAccounts(env);
  const byHealth: Record<string, string> = {};
  for (const h of Object.values(await getItemHealth(env))) for (const n of h.nicknames || []) byHealth[n] = h.item_id;
  for (const a of accounts) {
    if ((a.item_id || byHealth[a.nickname]) === itemId) await env.SYNC_STATE.delete(`last_account_sync:${a.plaid_account_id}`);
  }
}

// Frequency gating applies to automatic triggers (cron and Plaid webhooks), so an
// account set to "every hour" really syncs about hourly. Manual runs always go.
export function isAutomaticTrigger(trigger?: string): boolean {
  return trigger === "cron" || String(trigger || "").startsWith("webhook");
}

// A webhook from an account's own bank item bypasses its frequency setting, but never
// syncs the same account twice within this many minutes.
export const WEBHOOK_MIN_GAP_MINUTES = 2;

export async function accountIsDue(env: Env, acct: AccountConfig, setting: AccountAutomationSetting, overrideIntervalMinutes?: number): Promise<{ due: boolean; nextDueMinutes: number }> {
  const lastSyncRaw = await env.SYNC_STATE.get(`last_account_sync:${acct.plaid_account_id}`);
  if (!lastSyncRaw) return { due: true, nextDueMinutes: 0 };
  const ageMin = (Date.now() - new Date(lastSyncRaw).getTime()) / 60000;
  if (overrideIntervalMinutes != null) {
    return { due: ageMin >= overrideIntervalMinutes, nextDueMinutes: Math.max(0, Math.round(overrideIntervalMinutes - ageMin)) };
  }
  const interval = setting.sync_frequency_minutes || DEFAULT_SYNC_FREQUENCY_MINUTES;
  // Small tolerance so a 60-min account isn't skipped at the 59.9-minute cron tick.
  return { due: !(ageMin < interval - 2), nextDueMinutes: Math.max(0, Math.round(interval - ageMin)) };
}

export async function runSyncAll(env: Env, options: SyncOptions, lock: LockHandle | null): Promise<any> {
  options = { ...options, runId: options.runId || crypto.randomUUID() };
  let accounts: AccountConfig[];
  let accountSettings: AccountAutomationSetting[];
  try {
    accounts = await getAccounts(env);
    accountSettings = await getAccountAutomationSettings(env);
  } catch (e: any) {
    const errors = [{ account: "all", status: "error", error: e.message, friendly_error: String(e.message || "").replace(`${CONFIG_UNREADABLE}: `, "") }];
    if (!options.dryRun) {
      await env.SYNC_STATE.put("last_error", JSON.stringify({ ts: new Date().toISOString(), errors }));
      await maybeSendHealthAlert(env, { trigger: options.trigger || "unknown" }, errors);
    }
    return { ts: new Date().toISOString(), status: "completed_with_errors", trigger: options.trigger || "unknown", dry_run: !!options.dryRun, results: errors };
  }
  const results: any[] = [];
  const skippedIncomeRecords: SkippedIncomeRecord[] = [];
  const skipRules = await getSkipRules(env);
  const events: LogEvent[] = [];
  // Accounts linked before item ids were stored: learn their item id from the last
  // connection-health check (which asks Plaid for it).
  const itemIdByNickname: Record<string, string> = {};
  if (options.webhookItemId) {
    for (const h of Object.values(await getItemHealth(env))) {
      if (h.item_id && !h.item_id.startsWith("login:")) for (const n of h.nicknames || []) itemIdByNickname[n] = h.item_id;
    }
  }

  for (const acct of accounts) {
    try {
      if (lock) await renewSyncLock(env, lock);
      const accountSetting = settingForAccount(accountSettings, acct);

      // Pause takes effect mid-run: checked before every account (and again inside
      // the engine just before it writes), so nothing further is written once paused.
      if (!options.dryRun && !(await isSyncEnabled(env))) {
        results.push({ account: acct.nickname, status: "skipped - paused mid-run", automation: accountSetting });
        continue;
      }

      // An account that is off is skipped by every trigger, dry runs included.
      if (!accountSetting.sync_enabled) {
        results.push({ account: acct.nickname, status: "skipped - account sync off", automation: accountSetting });
        continue;
      }

      if (options.onlyAccount && acct.nickname !== options.onlyAccount) continue;

      const bootstrapped = await env.SYNC_STATE.get(`bootstrapped:${acct.plaid_account_id}`);
      if (bootstrapped && isAutomaticTrigger(options.trigger)) {
        const pushedByItsBank = !!options.webhookItemId && (acct.item_id || itemIdByNickname[acct.nickname]) === options.webhookItemId;
        const { due, nextDueMinutes } = await accountIsDue(env, acct, accountSetting, pushedByItsBank ? WEBHOOK_MIN_GAP_MINUTES : undefined);
        if (!due) {
          results.push({ account: acct.nickname, status: "skipped - not due", next_due_minutes: nextDueMinutes, automation: accountSetting });
          continue;
        }
      }

      if (!bootstrapped) {
        if (options.dryRun) {
          // Preview what setting it up would write: pending charges, plus posted ones
          // since YNAB's newest import that aren't in YNAB yet. Nothing is written.
          try {
            const plan = await bootstrapPlan(env, acct);
            const preview = await syncAccountEngine(env, acct, skipRules, { backfillOnly: true, dryRun: true, windowImport: plan.catchUp ? "all" : "pending", backfillDays: plan.backfillDays, importFloor: plan.floor, accountSetting, trigger: "bootstrap-preview" });
            results.push({ ...preview, account: acct.nickname, status: "dry-run - would set up", note: plan.catchUp ? `Not set up yet. The first live sync sets it up: pending charges, and posted charges from ${plan.floor} on that aren't in YNAB yet.` : "Not set up yet. The first live sync sets it up and imports what's pending.", automation: accountSetting });
          } catch (e: any) {
            results.push({ account: acct.nickname, status: "dry-run - account not bootstrapped", note: `Couldn't preview the setup (${friendlyErrorMessage(e)}).`, automation: accountSetting });
          }
          continue;
        }
        try {
          const b = await bootstrap(env, acct.nickname, options.runId);
          results.push({ account: acct.nickname, status: "auto-bootstrapped", automation: accountSetting, created_ids: b.result?.created_ids || [] });
          await env.SYNC_STATE.put(`last_account_sync:${acct.plaid_account_id}`, new Date().toISOString());
        } catch (e: any) {
          results.push({ account: acct.nickname, status: "bootstrap_failed", error: e?.message || String(e), friendly_error: friendlyErrorMessage(e), automation: accountSetting });
        }
        continue;
      }

      const r = await syncAccountEngine(env, acct, skipRules, { ...options, accountSetting, events });
      results.push({ account: acct.nickname, automation: accountSetting, ...r });

      // True "successfully polled" timestamp for frequency gating. Not stamped when
      // the run was paused mid-way, so the account is due again right after resume.
      if (!options.dryRun && (r.status === "ok" || r.status === "partial")) {
        await env.SYNC_STATE.put(`last_account_sync:${acct.plaid_account_id}`, new Date().toISOString());
      }
      if (Array.isArray(r.skipped_front_loaded_income)) skippedIncomeRecords.push(...r.skipped_front_loaded_income);
    } catch (e: any) {
      results.push({ account: acct.nickname, status: "error", error: e.message, friendly_error: friendlyErrorMessage(e) });
    }
  }

  const errors = results.filter(r => r.status === "error" || r.status === "bootstrap_failed");
  const partials = results.filter(r => r.status === "partial").map(r => ({ account: r.account, note: r.partial_note }));
  const anyWork = results.some((r: any) =>
    (r.created_count || 0) + (r.updated_count || 0) + (r.deleted_count || 0) + (r.added_count || 0) + (r.removed_count || 0) > 0
  );

  const summary: any = {
    ts: new Date().toISOString(),
    status: errors.length > 0 ? "completed_with_errors" : partials.length > 0 ? "completed_partial" : "completed",
    trigger: options.trigger || "unknown",
    dry_run: !!options.dryRun,
    lock_mode: lock?.mode || null,
    results
  };

  if (options.dryRun) return summary;

  // KV write economy: routine quiet runs only touch per-account timestamps. Webhook
  // runs never run the hourly audit (it calls the bank's real-time balance and a
  // webhook's background time is short); the next cron tick does.
  // A sync you start yourself always ends with a fresh health check: you're looking at
  // the dashboard, and "Last synced: just now" next to an hour-old Healthy is a lie.
  const auditWillRun = !String(options.trigger || "").startsWith("webhook") && !options.onlyAccount &&
    (String(options.trigger || "").startsWith("manual") || await shouldRunAudit(env));
  const isManual = !isAutomaticTrigger(options.trigger);
  const worthWriting = anyWork || errors.length > 0 || partials.length > 0 || isManual || auditWillRun;
  if (worthWriting) await env.SYNC_STATE.put("last_sync_summary", JSON.stringify(summary));

  // Partial results (some updates or removals didn't go through) are kept per
  // account until that account syncs cleanly.
  const ranAccounts = new Set(results.filter(r => ["ok", "partial", "error", "bootstrap_failed", "auto-bootstrapped"].includes(r.status)).map(r => r.account));
  const prevPartial = await readJson(env, "last_partial", null);
  const keptPartial = (prevPartial?.accounts || []).filter((p: any) => !ranAccounts.has(p.account));
  const nextPartial = [...keptPartial, ...partials];
  if (nextPartial.length > 0) {
    if (JSON.stringify(nextPartial) !== JSON.stringify(prevPartial?.accounts || [])) await env.SYNC_STATE.put("last_partial", JSON.stringify({ ts: new Date().toISOString(), accounts: nextPartial }));
  } else if (prevPartial) {
    await env.SYNC_STATE.delete("last_partial");
  }

  if (options.onlyAccount) {
    // A one-account run only speaks for that account: other accounts' errors stay,
    // and no alert is sent (a "recovered" alert here would be false).
    const prev = await readJson(env, "last_error", null);
    const others = (prev?.errors || []).filter((e: any) => e.account !== options.onlyAccount);
    const merged = [...others, ...errors];
    if (merged.length > 0) await env.SYNC_STATE.put("last_error", JSON.stringify({ ts: new Date().toISOString(), errors: merged }));
    else if (prev) await env.SYNC_STATE.delete("last_error");
    if (merged.length === 0) await env.SYNC_STATE.put("last_success_summary", JSON.stringify(summary));
    if (skippedIncomeRecords.length > 0) await appendSkippedIncomeHistory(env, skippedIncomeRecords);
    if (events.length > 0) await flushEventLog(env, events);
    const ran = results.some((r: any) => r.account === options.onlyAccount && !/^skipped/.test(String(r.status || "")));
    if (ran && String(options.trigger || "").startsWith("manual")) {
      try { await runAccountAudit(env, AUDIT_DAYS, STALE_PENDING_DAYS, options.onlyAccount); } catch { /* the hourly check will catch up */ }
    }
    return summary;
  }

  if (errors.length > 0) {
    await env.SYNC_STATE.put("last_error", JSON.stringify({ ts: new Date().toISOString(), errors }));
  } else {
    // Refresh the success heartbeat when something happened, or at least every
    // 30 minutes so the dashboard's "stale" check (45 min) stays meaningful.
    const prev = await readJson(env, "last_success_summary", null);
    const prevAge = prev?.ts ? (Date.now() - new Date(prev.ts).getTime()) / 60000 : Infinity;
    if (worthWriting || prevAge >= 30) await env.SYNC_STATE.put("last_success_summary", JSON.stringify(summary));
    if (await env.SYNC_STATE.get("last_error")) await env.SYNC_STATE.delete("last_error");
  }

  if (skippedIncomeRecords.length > 0) await appendSkippedIncomeHistory(env, skippedIncomeRecords);
  if (events.length > 0) await flushEventLog(env, events);

  // Undo entries were recorded by the engine as each account's rows were created.

  if (auditWillRun) {
    try {
      const audit = await runAccountAudit(env, AUDIT_DAYS, STALE_PENDING_DAYS);
      summary.account_audit = audit;
      await env.SYNC_STATE.put("last_audit_run_ts", new Date().toISOString());
      if (await env.SYNC_STATE.get("last_account_audit_error")) await env.SYNC_STATE.delete("last_account_audit_error");
      await env.SYNC_STATE.put("last_sync_summary", JSON.stringify(summary));
    } catch (e: any) {
      const auditError = { ts: new Date().toISOString(), error: friendlyErrorMessage(e) };
      summary.account_audit_error = auditError;
      await env.SYNC_STATE.put("last_account_audit_error", JSON.stringify(auditError));
    }
  } else if (!String(options.trigger || "").startsWith("webhook")) {
    // The last health check flagged an account and this sync just changed it (flipped
    // the stuck row, imported the missing charge): check that account again now, so
    // the chip and the banner don't keep showing a problem the sync already fixed.
    const stored = await readJson(env, "last_account_audit", null);
    const flagged = new Set((stored?.audits || []).filter((a: any) => a.status !== "healthy").map((a: any) => a.account));
    // (Linking a bank charge to a row you entered counts too: nothing was written, but
    // the "at the bank, not in YNAB" the check flagged is now settled.)
    // A sync you start yourself (Sync now, Re-scan) re-checks every flagged account it
    // ran, changed or not: you're looking at the dashboard and expect a current answer.
    const manual = String(options.trigger || "").startsWith("manual");
    const changed = results.filter((r: any) => flagged.has(r.account) && !/^skipped/.test(String(r.status || "")) && (manual || ((r.created_count || 0) + (r.updated_count || 0) + (r.deleted_count || 0) + (r.plan?.matched_existing?.length || 0)) > 0)).map((r: any) => r.account);
    for (const nickname of changed) {
      try { await runAccountAudit(env, AUDIT_DAYS, STALE_PENDING_DAYS, nickname); } catch { /* the hourly check will catch up */ }
    }
  }

  // A webhook sync (new bank data, often from a Sync now refresh) that changed YNAB
  // can't run the health check itself (short background time), so the next cron
  // tick, at most 15 minutes away, runs it instead of waiting out the hour.
  if (String(options.trigger || "").startsWith("webhook") && anyWork) {
    await env.SYNC_STATE.delete("last_audit_run_ts");
  }

  await maybeSendHealthAlert(env, summary, errors);
  return summary;
}

export async function shouldRunAudit(env: Env): Promise<boolean> {
  const last = await env.SYNC_STATE.get("last_audit_run_ts");
  if (!last) return true;
  // A check made by an older version of the worker is redone right after a deploy, so
  // the dashboard never keeps showing what the old code concluded.
  const stored = await readJson(env, "last_account_audit", null);
  if (stored && stored.worker_version !== WORKER_VERSION) return true;
  const ageMinutes = (Date.now() - new Date(last).getTime()) / 60000;
  return !Number.isFinite(ageMinutes) || ageMinutes >= AUDIT_MIN_INTERVAL_MINUTES;
}

export async function maybeSendHealthAlert(env: Env, summary: any, errors: any[]): Promise<void> {
  // Use the freshest audit we have (this run's, or the last stored one) so a
  // throttled run that skipped the audit can't look like a false "recovery".
  const auditForState = summary.account_audit || await readJson(env, "last_account_audit", null);
  const auditError = summary.account_audit_error || null;
  const needsAttention = (auditForState?.summary?.needs_attention || 0) > 0;
  const hasWarnings = (auditForState?.summary?.warning || 0) > 0 || !!auditError;
  const currentState = errors.length > 0 ? "error" : (needsAttention || hasWarnings ? "warning" : "ok");
  // The failing accounts are part of the state, so a SECOND account that starts
  // failing while another already is gets its own alert. Fewer failing accounts (one
  // recovered, others still failing) is recorded quietly.
  const failing = [...new Set(errors.map((e: any) => String(e.account || "all")))].sort();
  const stateKey = currentState === "error" ? `error:${failing.join(",")}` : currentState;
  const prevKey = (await env.SYNC_STATE.get("last_alert_state")) || "ok";
  if (stateKey === prevKey) return;
  const prevState = prevKey.startsWith("error") ? "error" : prevKey;
  const prevFailing = prevKey.startsWith("error:") ? prevKey.slice(6).split(",").filter(Boolean) : [];
  const newlyFailing = failing.filter(a => !prevFailing.includes(a));
  if (currentState === "error" && prevState === "error" && newlyFailing.length === 0) {
    await env.SYNC_STATE.put("last_alert_state", stateKey);
    return;
  }
  const alertErrors = currentState === "error" && prevState === "error" ? errors.filter((e: any) => newlyFailing.includes(String(e.account || "all"))) : errors;

  if (!env.ALERT_WEBHOOK_URL) {
    // Email only (Resend): syncs failing, and the recovery after that, are emailed.
    // Warnings stay on the dashboard so the inbox isn't noisy. The state is recorded
    // only once the email went out (or there was nothing to send), so a failed email
    // is retried next run.
    const apiKey = env.RESEND_API_KEY, to = env.ALERT_EMAIL_TO;
    const emailWorthy = currentState === "error" || prevState === "error";
    if (!apiKey || !to || !emailWorthy) { await env.SYNC_STATE.put("last_alert_state", stateKey); return; }
    const first = alertErrors[0] || {};
    const subject = currentState === "error" ? "⚠️ YNAB sync is failing" : "✅ YNAB sync recovered";
    const origin = env.WORKER_ORIGIN || "https://<your-worker>.workers.dev";
    const text = currentState === "error"
      ? `Your YNAB sync failed: ${first.friendly_error || first.error || "sync error"}${first.account ? ` (${prettyNickname(first.account)})` : ""}.\n\nThe dashboard has the details:\n${origin}/dashboard`
      : `Your YNAB sync is working again.${currentState === "warning" ? " The dashboard has a warning to look at." : ""}\n${origin}/dashboard`;
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.ALERT_EMAIL_FROM || "YNAB Sync <onboarding@resend.dev>", to: [to], subject, text })
      });
      if (!resp.ok) throw new Error(`Resend refused the email (${resp.status})`);
      await env.SYNC_STATE.put("last_alert_state", stateKey);
      const f = await readJson(env, "last_alert_failure", null);
      if (f?.kind === "sync_email") await env.SYNC_STATE.delete("last_alert_failure");
    } catch (e: any) {
      try { await env.SYNC_STATE.put("last_alert_failure", JSON.stringify({ ts: new Date().toISOString(), kind: "sync_email", error: String(e?.message || e) })); } catch { /* ignore */ }
    }
    return;
  }

  let message: string;
  if (currentState === "error") {
    const first = alertErrors[0] || {};
    const detail = first.friendly_error || first.error || "Sync error";
    message = `YNAB sync error${first.account && first.account !== "all" ? ` (${prettyNickname(first.account)})` : ""}: ${detail}`;
  } else if (currentState === "warning") {
    const n = auditForState?.summary?.needs_attention || 0;
    const w = auditForState?.summary?.warning || 0;
    message = auditError
      ? `YNAB sync warning: reconciliation data was unavailable. Open the dashboard to review.`
      : `YNAB sync warning: reconciliation flagged ${n} account(s) needing attention and ${w} warning(s). Open the dashboard to review.`;
  } else {
    message = `YNAB sync recovered — back to healthy.`;
  }

  // The new state is only recorded once the alert was delivered, so a failed alert is
  // retried on the next run instead of being silently marked as sent. The failure is
  // shown on the dashboard.
  try {
    // Keys cover the common targets: Slack ("text"), Discord ("content"), and a
    // generic "message". Point ALERT_WEBHOOK_URL at whatever you use.
    const resp = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: message,
        content: message,
        message,
        state: currentState,
        trigger: summary.trigger || "unknown",
        ts: new Date().toISOString()
      })
    });
    if (!resp.ok) throw new Error(`alert webhook answered ${resp.status}`);
    await env.SYNC_STATE.put("last_alert_state", stateKey);
    if (await env.SYNC_STATE.get("last_alert_failure")) await env.SYNC_STATE.delete("last_alert_failure");
  } catch (e: any) {
    // An alerting failure must never break or fail the sync itself.
    try { await env.SYNC_STATE.put("last_alert_failure", JSON.stringify({ ts: new Date().toISOString(), kind: "webhook", error: String(e?.message || e) })); } catch { /* ignore */ }
  }
}
