import { DEFAULT_SYNC_FREQUENCY_MINUTES, DEFAULT_TIMEZONE, WORKER_VERSION, ynabBudgetUrl } from "../constants";
import { STUCK_LOG_KEY, StuckEntry, getItemHealth } from "./items";
import { isSyncEnabled } from "../lock/lock";
import { getWebhookHistory } from "../plaid/webhooks";
import { getSkipRules } from "../rules/skip-rules";
import { CONFIG_UNREADABLE, getAccountAutomationSettings, getAccounts, settingForAccount } from "../store/accounts";
import { Env, ItemHealth } from "../types";

// ---------- Status / health ----------

export async function status(env: Env): Promise<any> {
  const accounts = await getAccounts(env);
  const accountSettings = await getAccountAutomationSettings(env);
  const out: any[] = [];

  for (const a of accounts) {
    const bootstrapped = await env.SYNC_STATE.get(`bootstrapped:${a.plaid_account_id}`);
    const cursor = await env.SYNC_STATE.get(`cursor:${a.plaid_account_id}`);
    const lastAccountSync = await env.SYNC_STATE.get(`last_account_sync:${a.plaid_account_id}`);
    const setting = settingForAccount(accountSettings, a);
    const interval = setting.sync_frequency_minutes || DEFAULT_SYNC_FREQUENCY_MINUTES;
    const ageMinutes = lastAccountSync ? (Date.now() - new Date(lastAccountSync).getTime()) / 60000 : null;
    // Same 2-minute tolerance as accountIsDue, so "due now" matches what the cron does.
    const nextDueMinutes = ageMinutes != null && ageMinutes < interval - 2 ? Math.max(0, Math.round(interval - ageMinutes)) : 0;
    // Overdue: enabled, set up, and not synced for its interval plus 30 minutes of
    // slack. Catches one account silently failing while the others keep working.
    const overdue = setting.sync_enabled && bootstrapped === "1" && ageMinutes != null && ageMinutes > interval + 30;

    out.push({
      nickname: a.nickname,
      bootstrapped: bootstrapped === "1",
      cursor_set: !!cursor,
      last_account_sync: lastAccountSync || null,
      next_due_minutes: nextDueMinutes,
      overdue,
      automation: setting
    });
  }

  return { accounts: out };
}

export async function health(env: Env): Promise<any> {
  try {
    return await healthReport(env);
  } catch (e: any) {
    if (!String(e?.message || "").startsWith(CONFIG_UNREADABLE)) throw e;
    const text = String(e.message).replace(`${CONFIG_UNREADABLE}: `, "");
    return {
      ok: false, health_status: "error", sync_enabled: await isSyncEnabled(env), now: new Date().toISOString(),
      attention_level: "bad", attention: [{ level: "bad", text }], account_statuses: {},
      last_error: { errors: [{ account: "all", friendly_error: text }] }, status: { accounts: [] },
      lock_mode: env.SYNC_LOCK ? "durable-object" : "missing-required-binding"
    };
  }
}

export async function healthReport(env: Env): Promise<any> {
  const syncEnabled = await isSyncEnabled(env);
  const lastSync = await readJson(env, "last_sync_summary", null);
  const lastSuccess = await readJson(env, "last_success_summary", null);
  const lastError = await readJson(env, "last_error", null);
  const skippedIncomeHistory = await readJson(env, "skipped_income_history", []);
  const webhookHistory = await getWebhookHistory(env);
  const skipRules = await getSkipRules(env);
  const lastAccountAudit = await readJson(env, "last_account_audit", null);
  const lastAccountAuditError = await readJson(env, "last_account_audit_error", null);
  const accountAutomationSettings = await getAccountAutomationSettings(env);
  const statusReport = await status(env);
  const overdueAccounts = statusReport.accounts.filter((a: any) => a.overdue).map((a: any) => a.nickname);

  const lastSuccessAgeMinutes = lastSuccess?.ts
    ? Math.max(0, Math.round((Date.now() - new Date(lastSuccess.ts).getTime()) / 60000))
    : null;
  // Leftovers about an account whose worker sync is now off (you fixed things by hand
  // and went back to Direct Import) no longer apply to anything the worker does.
  const syncOn = new Set(accountAutomationSettings.filter(s => s.sync_enabled).map(s => s.nickname));
  const rawPartial = await readJson(env, "last_partial", null);
  const partialAccounts = (rawPartial?.accounts || []).filter((p: any) => syncOn.has(p.account));
  const lastPartial = partialAccounts.length ? { ...rawPartial, accounts: partialAccounts } : null;
  const lastAlertFailure = await readJson(env, "last_alert_failure", null);
  const itemHealth = await getItemHealth(env);

  // One place decides each account's status and what the banner says, so the chip,
  // the healthy count, the banner and the headline can't contradict each other.
  const verdict = accountVerdicts(statusReport.accounts, lastAccountAudit, itemHealth, lastError, lastPartial, env.TIMEZONE || DEFAULT_TIMEZONE);
  const attention: Array<{ level: "bad" | "warn"; text: string }> = [];
  if (!syncEnabled) attention.push({ level: "warn", text: "Global sync is paused (Settings)." });
  if (!env.SYNC_LOCK) attention.push({ level: "bad", text: "The SYNC_LOCK Durable Object isn't bound. Financial writes are disabled until the atomic lock binding is configured." });
  for (const e of (lastError?.errors || [])) attention.push({ level: "bad", text: `${prettyNickname(e.account)}: sync failed. ${e.friendly_error || e.error}` });
  attention.push(...verdict.attention);
  if (lastAccountAuditError) attention.push({ level: "warn", text: `The last health check failed (${lastAccountAuditError.error}). The figures shown are from ${lastAccountAudit?.ts ? "the check at " + lastAccountAudit.ts : "an earlier check"}.` });
  const auditAgeMin = lastAccountAudit?.ts ? (Date.now() - Date.parse(lastAccountAudit.ts)) / 60000 : null;
  if (syncEnabled && auditAgeMin != null && auditAgeMin > 180) attention.push({ level: "warn", text: `Balance figures are from a health check ${Math.round(auditAgeMin / 60)} hours ago. Click Re-check for fresh ones.` });
  const stuck = ((await readJson(env, STUCK_LOG_KEY, [])) as StuckEntry[]).filter(e => !e.resolved_at && (e.sightings || 1) >= 2 && syncOn.has(e.account));
  if (stuck.length) attention.push({ level: "warn", text: `${stuck.length} pending row(s) should have moved to posted but haven't (${stuck.slice(0, 3).map(e => `${prettyNickname(e.account)}: ${e.payee} $${Math.abs(e.amount).toFixed(2)}`).join(", ")}). The reason is saved under Recovery > Stuck pending rows.` });
  const stuckCheckError = await readJson(env, "last_stuck_check_error", null);
  if (stuckCheckError?.ts && Date.now() - Date.parse(stuckCheckError.ts) < 3 * 3600e3) attention.push({ level: "warn", text: `The check for stuck pending rows couldn't run on ${prettyNickname(stuckCheckError.account)} (${String(stuckCheckError.error).slice(0, 140)}). It retries with the next health check.` });
  if (lastAlertFailure) attention.push({ level: "warn", text: `An alert couldn't be sent (${lastAlertFailure.kind}: ${String(lastAlertFailure.error).slice(0, 160)}). It will be retried.` });
  if (syncEnabled && lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes > 45 && overdueAccounts.length === 0) attention.push({ level: "warn", text: `No successful sync in ${lastSuccessAgeMinutes} minutes.` });

  const anyBad = attention.some(x => x.level === "bad");
  let healthStatus = "healthy";
  if (!syncEnabled) healthStatus = "paused";
  else if (lastError || verdict.hasError) healthStatus = "error";
  // Any account warning (including "health check unavailable"), a failed health check,
  // partial results or a failed alert makes the headline a warning, so it never reads
  // healthier than the accounts do.
  // Any warning line in the banner (a stuck row, figures hours old) means the pill
  // can't say Healthy; "no successful sync lately" is the "stale" state below instead.
  else if (anyBad || attention.some(x => x.level === "warn" && !/^No successful sync/.test(x.text)) || verdict.hasWarning || lastAccountAuditError || lastPartial || lastAlertFailure ||
    (lastAccountAudit?.summary?.needs_attention || 0) > 0 || (lastAccountAudit?.summary?.warning || 0) > 0) healthStatus = "warning";
  else if ((lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes > 45) || overdueAccounts.length > 0) healthStatus = "stale";
  else if (!lastSuccess) healthStatus = "no_success_yet";

  return {
    ok: true,
    health_status: healthStatus,
    last_success_age_minutes: lastSuccessAgeMinutes,
    sync_enabled: syncEnabled,
    now: new Date().toISOString(),
    ynab_budget_url: ynabBudgetUrl(env.YNAB_BUDGET_ID),
    webhook_url_hint: "/webhook",
    last_sync: lastSync,
    last_success: lastSuccess,
    last_error: lastError,
    skipped_income_history: skippedIncomeHistory,
    webhook_history: webhookHistory,
    skip_rules: skipRules,
    account_automation_settings: accountAutomationSettings,
    last_account_audit: lastAccountAudit,
    last_account_audit_error: lastAccountAuditError,
    overdue_accounts: overdueAccounts,
    // "bad" when something needs you, "warn" when there's something to check.
    attention_level: anyBad ? "bad" : attention.length ? "warn" : "ok",
    attention,
    account_statuses: verdict.statuses,
    last_partial: lastPartial,
    last_alert_failure: lastAlertFailure,
    // "durable-object" is a real mutex. "kv-best-effort" means the SYNC_LOCK binding
    // is missing from wrangler.toml and overlapping runs are only mostly prevented.
    lock_mode: env.SYNC_LOCK ? "durable-object" : "missing-required-binding",
    worker_version: WORKER_VERSION,
    status: statusReport
  };
}

export function prettyNickname(n: string): string {
  return String(n || "").split("-").map(w => w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export interface AccountVerdict { level: "ok" | "warn" | "bad" | ""; label: string; secondary: string; tracked: boolean }

// Each account's status, from every signal in one place: connection health, sync
// errors, overdue syncs, partial results and the balance check. The dashboard shows
// these as-is.
export function accountVerdicts(statusRows: any[], audit: any, itemHealth: Record<string, ItemHealth>, lastError: any, lastPartial: any, timeZone = DEFAULT_TIMEZONE) {
  const localTime = (iso: string) => {
    try { return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
    catch { return iso.slice(11, 16) + " UTC"; }
  };
  const audits: Record<string, any> = {};
  for (const a of (audit?.audits || [])) audits[a.account] = a;
  const items: Record<string, ItemHealth> = {};
  for (const h of Object.values(itemHealth || {})) for (const n of h.nicknames || []) items[n] = h;
  const errored = new Set((lastError?.errors || []).map((e: any) => e.account));
  const partial: Record<string, string> = {};
  for (const p of (lastPartial?.accounts || [])) partial[p.account] = p.note || "some changes didn't go through";

  const statuses: Record<string, AccountVerdict> = {};
  const attention: Array<{ level: "bad" | "warn"; text: string }> = [];
  let hasError = false, hasWarning = false;
  for (const st of statusRows) {
    const n = st.nickname;
    const syncOn = st.automation?.sync_enabled !== false;
    const auditOn = st.automation?.audit_enabled !== false;
    const a = auditOn ? audits[n] : undefined;
    const ih = items[n];
    const name = prettyNickname(n);
    const secondary = syncOn ? "" : "Worker sync off" + (auditOn ? " (health-checked)" : "");
    let v: AccountVerdict;
    const bad = (label: string, text: string, isError = false) => { v = { level: "bad", label, secondary, tracked: true }; attention.push({ level: "bad", text: `${name}: ${text}` }); if (isError) hasError = true; };
    const warn = (label: string, text?: string) => { v = { level: "warn", label, secondary, tracked: true }; if (text) attention.push({ level: "warn", text: `${name}: ${text}` }); hasWarning = true; };
    v = { level: "ok", label: "Healthy", secondary, tracked: syncOn || auditOn };
    if (!syncOn && !auditOn) {
      v = { level: "", label: "Off", secondary: "Not synced or checked", tracked: false };
    } else if (ih && ih.status === "needs_reauth") {
      bad("Needs reconnect", `the bank connection needs to be reconnected (${ih.error || "login required"}). Use Settings > Reconnect.`, true);
    } else if (syncOn && errored.has(n)) {
      v = { level: "bad", label: "Sync failed", secondary, tracked: true }; hasError = true; // the error itself is already a banner line
    } else if (syncOn && st.overdue) {
      bad("Not syncing", "hasn't synced for longer than its schedule allows.", true);
    } else if (syncOn && st.bootstrapped === false) {
      warn("Not set up yet", "not set up yet; the next sync sets it up.");
    } else if (syncOn && partial[n] && !(a && a.status === "needs_attention")) {
      warn("Partly synced", partial[n]);
    } else if (a && a.audit_unavailable) {
      warn("Check unavailable", (a.warnings || [])[0] || "the health check couldn't read its data.");
    } else if (a && a.bank_balance == null) {
      warn("Bank balance unreadable", "the bank balance couldn't be read, so the balance wasn't checked.");
    } else if (a && a.status === "needs_attention") {
      const reasons: string[] = a.attention_reasons || [];
      const label = a.unexplained_difference != null && Math.abs(a.unexplained_difference) > 25 ? "Balance off" : a.stale_pending_count ? "Stale pending" : "Needs attention";
      v = { level: "bad", label, secondary, tracked: true };
      for (const r of (reasons.length ? reasons : [(a.warnings || [])[0] || "balance differs from the bank."])) attention.push({ level: "bad", text: `${name}: ${r}` });
    } else if (ih && ih.status === "stale") {
      warn("Bank data stale", `the bank hasn't sent new data since ${ih.last_bank_update ? ih.last_bank_update.slice(0, 10) : "a while"}. If it doesn't catch up, reconnect it.`);
    } else if (ih && ih.status === "error") {
      warn("Connection issue", `the bank connection reported ${ih.error || "an error"}; usually temporary.`);
    } else if (a && a.status === "warning") {
      warn(a.explained_difference ? "Known difference" : "Check", a.explained_by ? `${a.explained_by} (as of the ${a.checked_at ? "check at " + localTime(a.checked_at) : "last check"}; Re-check after fixing it).` : (a.warnings || [])[0]);
    }
    statuses[n] = v!;
  }
  return { statuses, attention, hasError, hasWarning };
}

export async function readJson(env: Env, key: string, fallback: any): Promise<any> {
  const raw = await env.SYNC_STATE.get(key);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    // A value of the wrong shape ("null", a list where a map belongs) is treated like
    // a missing one, so one bad KV value can't stop an account syncing for good.
    if (fallback !== null && fallback !== undefined) {
      if (parsed === null || typeof parsed !== typeof fallback || Array.isArray(parsed) !== Array.isArray(fallback)) return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}
