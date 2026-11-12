import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, DEFAULT_SYNC_FREQUENCY_MINUTES, SYNC_FREQUENCY_OPTIONS } from "../constants";
import { AccountAutomationSetting, AccountConfig, Env } from "../types";

// ---------- Account automation settings ----------

export function defaultSettingForAccount(nickname: string): AccountAutomationSetting {
  const configured = DEFAULT_ACCOUNT_AUTOMATION_SETTINGS.find(s => s.nickname === nickname);
  if (configured) return { ...configured };

  // Any account not listed above starts OFF: nothing syncs until you turn it on.
  return {
    nickname,
    sync_enabled: false,
    backfill_enabled: false,
   
    sync_frequency_minutes: DEFAULT_SYNC_FREQUENCY_MINUTES,
    audit_enabled: true
  };
}

// ---------- Account store (KV-backed, with env fallback) ----------
//
// Accounts used to live only in the ACCOUNT_MAP wrangler var, so every bank
// reconnect meant editing the var and redeploying. Now the source of truth is
// KV (key "account_map"); the env var is just the seed/fallback used until the
// first dashboard save. getAccounts() reads KV first and falls back to env so
// nothing breaks before any write. Editing accounts from the dashboard (or the
// link flow) writes KV and takes effect immediately — no deploy.

export const ACCOUNT_MAP_KV_KEY = "account_map";
export const ACCOUNT_CONFIG_BUNDLE_KEY = "account_config_bundle";
export const CONFIG_UNREADABLE = "CONFIG_UNREADABLE";

function validateAccountMap(value: any, source: string): AccountConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${CONFIG_UNREADABLE}: ${source} must be an array of account objects.`);
  }
  const nicknames = new Set<string>();
  const plaidIds = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${CONFIG_UNREADABLE}: ${source} entry ${index + 1} is not an account object.`);
    }
    const nickname = String(item.nickname || "").trim().toLowerCase().replace(/\s+/g, "-");
    const plaidToken = typeof item.plaid_access_token === "string" ? item.plaid_access_token.trim() : "";
    const plaidId = typeof item.plaid_account_id === "string" ? item.plaid_account_id.trim() : "";
    const ynabId = typeof item.ynab_account_id === "string" ? item.ynab_account_id.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(nickname) || !plaidToken || !plaidId || !ynabId) {
      throw new Error(`${CONFIG_UNREADABLE}: ${source} entry ${index + 1} is missing a valid nickname, Plaid token, Plaid account ID, or YNAB account ID.`);
    }
    if (nicknames.has(nickname)) {
      throw new Error(`${CONFIG_UNREADABLE}: ${source} contains duplicate account nickname '${nickname}'.`);
    }
    if (plaidIds.has(plaidId)) {
      throw new Error(`${CONFIG_UNREADABLE}: ${source} maps Plaid account '${plaidId}' more than once.`);
    }
    if (item.is_credit_card !== undefined && typeof item.is_credit_card !== "boolean") {
      throw new Error(`${CONFIG_UNREADABLE}: is_credit_card for '${nickname}' must be a boolean.`);
    }
    if (item.institution !== undefined && typeof item.institution !== "string") {
      throw new Error(`${CONFIG_UNREADABLE}: institution for '${nickname}' must be a string.`);
    }
    if (item.item_id !== undefined && typeof item.item_id !== "string") {
      throw new Error(`${CONFIG_UNREADABLE}: item_id for '${nickname}' must be a string.`);
    }
    const paymentMatch = item.payment_match === undefined ? undefined : cleanPaymentMatch(item.payment_match);
    if (item.payment_match !== undefined && !paymentMatch) {
      throw new Error(`${CONFIG_UNREADABLE}: payment_match for '${nickname}' is invalid.`);
    }
    nicknames.add(nickname);
    plaidIds.add(plaidId);
    return {
      ...item,
      nickname,
      plaid_access_token: plaidToken,
      plaid_account_id: plaidId,
      ynab_account_id: ynabId,
      payment_match: paymentMatch
    } as AccountConfig;
  });
}

export async function getAccounts(env: Env): Promise<AccountConfig[]> {
  try {
    const bundleRaw = await env.SYNC_STATE.get(ACCOUNT_CONFIG_BUNDLE_KEY);
    if (bundleRaw !== null) {
      let bundle: any;
      try { bundle = JSON.parse(bundleRaw); } catch { bundle = null; }
      if (!bundle || !Array.isArray(bundle.accounts)) {
        throw new Error(`${CONFIG_UNREADABLE}: the combined account configuration is unreadable. Nothing was synced.`);
      }
      return validateAccountMap(bundle.accounts, 'combined account configuration');
    }
    const raw = await env.SYNC_STATE.get(ACCOUNT_MAP_KV_KEY);
    // Once the account list lives in KV it is the only source: the ACCOUNT_MAP
    // env var is a first-run seed and is never silently brought back.
    if (raw !== null) {
      let parsed: any = undefined;
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      if (Array.isArray(parsed)) return validateAccountMap(parsed, 'saved account map (KV "account_map")');
      // Present but unreadable: stop, rather than quietly running on the env seed.
      throw new Error(`${CONFIG_UNREADABLE}: the saved account list (KV "account_map") can't be read. Nothing was synced. Re-save your accounts in Settings, or restore account_map.`);
    }
  } catch (e: any) {
    if (String(e?.message || "").startsWith(CONFIG_UNREADABLE)) throw e;
    // The env var is only a first-deploy seed. If KV is unavailable after the
    // worker has been configured, it may be stale; never silently sync against it.
    throw new Error("SYNC_STATE is unavailable; refusing to use the potentially stale ACCOUNT_MAP seed. No account sync was performed.");
  }
  try {
    const seed = JSON.parse(env.ACCOUNT_MAP || "[]");
    return validateAccountMap(seed, "ACCOUNT_MAP environment seed");
  } catch {
    throw new Error(`${CONFIG_UNREADABLE}: ACCOUNT_MAP environment seed contains invalid JSON. Correct the account configuration before syncing.`);
  }
}

export async function putAccounts(env: Env, accounts: AccountConfig[]): Promise<void> {
  const bundleRaw = await env.SYNC_STATE.get(ACCOUNT_CONFIG_BUNDLE_KEY);
  if (bundleRaw !== null) {
    let bundle: any;
    try { bundle = JSON.parse(bundleRaw); } catch { throw new Error(`${CONFIG_UNREADABLE}: combined account configuration can't be updated.`); }
    if (!bundle || !Array.isArray(bundle.accounts) || !Array.isArray(bundle.settings)) {
      throw new Error(`${CONFIG_UNREADABLE}: combined account configuration can't be updated.`);
    }
    await env.SYNC_STATE.put(ACCOUNT_CONFIG_BUNDLE_KEY, JSON.stringify({ ...bundle, accounts }, null, 2));
    return;
  }
  await env.SYNC_STATE.put(ACCOUNT_MAP_KV_KEY, JSON.stringify(accounts, null, 2));
}

// Merge edited accounts into the stored map. A blank token keeps the stored one, so
// the dashboard never has to send secrets back.
export async function saveAccountsMerged(env: Env, incoming: any[], persist = true): Promise<AccountConfig[]> {
  if (!Array.isArray(incoming) || incoming.length === 0) throw new Error("accounts must be a non-empty array");
  const nicknames = new Set<string>();
  const plaidIds = new Set<string>();
  for (const [index, item] of incoming.entries()) {
    if (!item || typeof item !== "object") throw new Error("Account " + (index + 1) + " must be an object.");
    const nickname = String(item.nickname || "").trim().toLowerCase().replace(/\s+/g, "-");
    const plaidId = String(item.plaid_account_id || "").trim();
    const ynabId = String(item.ynab_account_id || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(nickname)) throw new Error("Invalid account nickname: " + String(item.nickname || "") + ".");
    if (!plaidId || !ynabId) throw new Error("Account " + nickname + " requires Plaid and YNAB account IDs.");
    if (nicknames.has(nickname)) throw new Error("Duplicate account nickname: " + nickname + ".");
    if (plaidIds.has(plaidId)) throw new Error("Plaid account " + plaidId + " is mapped more than once.");
    if (item.is_credit_card !== undefined && typeof item.is_credit_card !== "boolean") throw new Error("is_credit_card for " + nickname + " must be a boolean.");
    nicknames.add(nickname);
    plaidIds.add(plaidId);
  }

  const byNick: Record<string, AccountConfig> = {};
  let stored: AccountConfig[] = [];
  try { stored = await getAccounts(env); }
  catch (e: any) {
    // The saved list is unreadable: saving a complete list (with tokens) is how you
    // fix it, so allow that. Without tokens there is nothing to rebuild from.
    if (!String(e?.message || "").startsWith(CONFIG_UNREADABLE)) throw e;
    const missing = incoming.filter((a: any) => !String(a?.plaid_access_token || "").trim()).map((a: any) => a?.nickname);
    if (missing.length) throw new Error(`${CONFIG_UNREADABLE}: the saved account list can't be read, so it can only be replaced with a complete one. Include the Plaid access token for: ${missing.join(", ")}.`);
  }
  // A nickname is a display label, not a durable financial identity. Refuse to
  // silently retarget an existing mapping: its cursor, ownership links, undo log,
  // and reconciliation history are keyed to the old Plaid/YNAB identities. A
  // token rotation for the same two account IDs remains allowed.
  const incomingByPlaidId = new Map(incoming.map((item: any) => [String(item.plaid_account_id || "").trim(), item]));
  for (const previous of stored) {
    const sameNickname = incoming.find((item: any) =>
      String(item.nickname || "").trim().toLowerCase().replace(/\s+/g, "-") === previous.nickname
    );
    if (sameNickname &&
      (String(sameNickname.plaid_account_id || "").trim() !== previous.plaid_account_id ||
       String(sameNickname.ynab_account_id || "").trim() !== previous.ynab_account_id)) {
      throw new Error(`Account mapping for '${previous.nickname}' cannot change Plaid or YNAB account IDs in place. Disable sync and use an explicit account migration; existing transaction ownership and cursor state will not be moved automatically.`);
    }
    const reused = incomingByPlaidId.get(previous.plaid_account_id) as any;
    if (reused) {
      const reusedNickname = String(reused.nickname || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (reusedNickname !== previous.nickname || String(reused.ynab_account_id || "").trim() !== previous.ynab_account_id) {
        throw new Error(`Plaid account '${previous.plaid_account_id}' is already associated with '${previous.nickname}' and cannot be silently renamed or moved to another YNAB account.`);
      }
    }
  }

  stored.forEach(a => { byNick[a.nickname] = a; });
  const merged: AccountConfig[] = incoming.map((a: any) => {
    const nickname = String(a.nickname).trim().toLowerCase().replace(/\s+/g, "-");
    const prev = byNick[nickname] || ({} as AccountConfig);
    const token = (a.plaid_access_token && String(a.plaid_access_token).trim()) ? String(a.plaid_access_token).trim() : prev.plaid_access_token;
    return {
      nickname,
      institution: a.institution ?? prev.institution ?? "",
      plaid_access_token: token,
      plaid_account_id: a.plaid_account_id ?? prev.plaid_account_id ?? "",
      ynab_account_id: a.ynab_account_id ?? prev.ynab_account_id ?? "",
      item_id: a.item_id ?? prev.item_id ?? "",
      is_credit_card: a.is_credit_card ?? prev.is_credit_card,
      payment_match: a.payment_match !== undefined ? cleanPaymentMatch(a.payment_match) : prev.payment_match
    } as AccountConfig;
  });
  if (persist) await putAccounts(env, merged);
  return merged;
}

export function cleanPaymentMatch(m: any): { last4: string[]; words: string[] } | undefined {
  if (!m) return undefined;
  const list = (v: any) => (Array.isArray(v) ? v : String(v || "").split(","))
    .map((x: any) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 10);
  const out = { last4: list(m.last4).filter((x: string) => /^\d{3,5}$/.test(x)), words: list(m.words) };
  return out.last4.length || out.words.length ? out : undefined;
}

// ?account=<nickname> on a manual action: undefined = all accounts, null = unknown name.
export async function accountParam(env: Env, url: URL): Promise<string | undefined | null> {
  const name = url.searchParams.get("account");
  if (!name) return undefined;
  return (await getAccounts(env)).some(a => a.nickname === name) ? name : null;
}

// Mask tokens completely; even a stable prefix is unnecessary diagnostic exposure.
export function maskToken(t: string | undefined): string {
  return t ? "••••••••" : "";
}

export async function getAccountAutomationSettings(env: Env): Promise<AccountAutomationSetting[]> {
  const bundleRaw = await env.SYNC_STATE.get(ACCOUNT_CONFIG_BUNDLE_KEY);
  let accounts: AccountConfig[];
  let raw: string | null;
  if (bundleRaw !== null) {
    let bundle: any;
    try { bundle = JSON.parse(bundleRaw); } catch { bundle = null; }
    if (!bundle || !Array.isArray(bundle.accounts) || !Array.isArray(bundle.settings)) {
      throw new Error(`${CONFIG_UNREADABLE}: the combined account configuration can't be read. Nothing was synced.`);
    }
    // Read account identity and automation policy from the same KV value so a
    // concurrent commit cannot mix the previous account list with new settings.
    accounts = validateAccountMap(bundle.accounts, "combined account configuration");
    raw = JSON.stringify(bundle.settings);
  } else {
    accounts = await getAccounts(env);
    raw = await env.SYNC_STATE.get("account_automation_settings");
  }

  let saved: any[] = [];
  if (raw) {
    let parsed: any = undefined;
    try { parsed = JSON.parse(raw); } catch { /* handled below */ }
    // Unreadable settings must not fall back to defaults (which would turn sync back
    // on for accounts you turned off).
    if (!Array.isArray(parsed)) throw new Error(`${CONFIG_UNREADABLE}: the saved account settings (KV "account_automation_settings") can't be read. Nothing was synced. Re-save them in Settings.`);
    saved = parsed;
  }

  for (const item of saved) {
    if (!item || typeof item.nickname !== "string" || !item.nickname.trim()) {
      throw new Error(`${CONFIG_UNREADABLE}: saved account settings contain an invalid entry.`);
    }
    for (const field of ["sync_enabled", "backfill_enabled", "audit_enabled"]) {
      if (item[field] !== undefined && typeof item[field] !== "boolean") {
        throw new Error(`${CONFIG_UNREADABLE}: saved setting ${field} for ${item.nickname} is not a boolean.`);
      }
    }
  }

  return accounts.map(acct => {
    const defaults = defaultSettingForAccount(acct.nickname);
    const override = saved.find(s => s && s.nickname === acct.nickname) || {};
    const freq = Number(override.sync_frequency_minutes);

    return {
      nickname: acct.nickname,
      sync_enabled: override.sync_enabled !== undefined ? override.sync_enabled : defaults.sync_enabled,
      backfill_enabled: override.backfill_enabled !== undefined ? override.backfill_enabled : defaults.backfill_enabled,
      sync_frequency_minutes: SYNC_FREQUENCY_OPTIONS.includes(freq) ? freq : defaults.sync_frequency_minutes,
      audit_enabled: override.audit_enabled !== undefined ? override.audit_enabled : defaults.audit_enabled
    };
  });
}

export async function putAccountAutomationSettings(env: Env, settings: any[], accountOverride?: AccountConfig[], persist = true, applySideEffects = true): Promise<AccountAutomationSetting[]> {
  const accounts = accountOverride || await getAccounts(env);

  // Load the CURRENTLY SAVED settings so a partial save (e.g. the Account config
  // panel sends only sync_frequency_minutes) preserves fields it didn't send.
  // Previously the fallback was the hardcoded default, whose sync_enabled is true —
  // so saving a frequency silently re-enabled every account the user had turned off
  // (this was the "an account's sync turned itself back on" bug). Fallback order is now:
  // input value -> existing saved value -> built-in default.
  let saved: AccountAutomationSetting[] = [];
  const bundleRaw = await env.SYNC_STATE.get(ACCOUNT_CONFIG_BUNDLE_KEY);
  let raw = await env.SYNC_STATE.get("account_automation_settings");
  if (bundleRaw !== null) {
    let bundle: any;
    try { bundle = JSON.parse(bundleRaw); } catch { bundle = null; }
    if (!bundle || !Array.isArray(bundle.accounts) || !Array.isArray(bundle.settings)) {
      throw new Error(`${CONFIG_UNREADABLE}: the combined account configuration can't be read. Restore valid configuration before making a partial change.`);
    }
    raw = JSON.stringify(bundle.settings);
  }
  if (raw !== null) {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error(`${CONFIG_UNREADABLE}: the saved account settings can't be read. Restore valid settings before making a partial change.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${CONFIG_UNREADABLE}: the saved account settings aren't an array. Restore valid settings before making a partial change.`);
    }
    for (const item of parsed) {
      if (!item || typeof item.nickname !== "string" || !item.nickname.trim()) {
        throw new Error(`${CONFIG_UNREADABLE}: saved account settings contain an invalid entry.`);
      }
      for (const field of ["sync_enabled", "backfill_enabled", "audit_enabled"]) {
        if (item[field] !== undefined && typeof item[field] !== "boolean") {
          throw new Error(`${CONFIG_UNREADABLE}: saved setting ${field} for ${item.nickname} is not a boolean.`);
        }
      }
    }
    saved = parsed;
  }
  if (!Array.isArray(settings)) throw new Error("settings must be an array");
  for (const item of settings) {
    if (!item || typeof item.nickname !== "string" || !item.nickname.trim()) throw new Error("Every setting requires a nickname.");
    for (const field of ["sync_enabled", "backfill_enabled", "audit_enabled"]) {
      if (item[field] !== undefined && typeof item[field] !== "boolean") throw new Error(`${field} must be a boolean.`);
    }
    if (item.sync_frequency_minutes !== undefined &&
      !SYNC_FREQUENCY_OPTIONS.includes(Number(item.sync_frequency_minutes))) {
      throw new Error("sync_frequency_minutes must be one of the supported frequency options.");
    }
  }

  const normalized = accounts.map(acct => {
    const defaults = defaultSettingForAccount(acct.nickname);
    const prev = saved.find(s => s && s.nickname === acct.nickname) || {} as any;
    const input = Array.isArray(settings) ? settings.find(s => s && s.nickname === acct.nickname) || {} : {};
    const freq = Number(input.sync_frequency_minutes);
    const prevFreq = Number(prev.sync_frequency_minutes);

    // For each field: use the input if provided, else the existing saved value,
    // else the built-in default. This makes partial saves non-destructive.
    const pick = (inVal: any, prevVal: any, defVal: boolean): boolean =>
      inVal !== undefined ? inVal
      : prevVal !== undefined ? prevVal
      : defVal;

    return {
      nickname: acct.nickname,
      sync_enabled: pick(input.sync_enabled, prev.sync_enabled, defaults.sync_enabled),
      backfill_enabled: pick(input.backfill_enabled, prev.backfill_enabled, defaults.backfill_enabled),
      sync_frequency_minutes:
        SYNC_FREQUENCY_OPTIONS.includes(freq) ? freq
        : SYNC_FREQUENCY_OPTIONS.includes(prevFreq) ? prevFreq
        : defaults.sync_frequency_minutes,
      audit_enabled: pick(input.audit_enabled, prev.audit_enabled, defaults.audit_enabled)
    };
  });

  if (persist) {
    if (bundleRaw !== null) {
      const bundle = JSON.parse(bundleRaw);
      await env.SYNC_STATE.put(ACCOUNT_CONFIG_BUNDLE_KEY, JSON.stringify({ ...bundle, settings: normalized }, null, 2));
    } else {
      await env.SYNC_STATE.put("account_automation_settings", JSON.stringify(normalized, null, 2));
    }
  }
  // Sync turned back ON for an account the worker had set up before: its saved bank
  // position is from when sync was last on, and replaying everything since would
  // re-create charges Direct Import (or you) already put in YNAB. Set it up fresh
  // instead; the next sync bootstraps it and catches up from YNAB's newest import.
  if (applySideEffects && persist) for (const acct of accounts) {
    const prev = saved.find(s => s && s.nickname === acct.nickname) || {} as any;
    const wasOn = prev.sync_enabled !== undefined ? prev.sync_enabled !== false : defaultSettingForAccount(acct.nickname).sync_enabled;
    const nowOn = normalized.find(n => n.nickname === acct.nickname)?.sync_enabled;
    if (!wasOn && nowOn && (await env.SYNC_STATE.get(`bootstrapped:${acct.plaid_account_id}`)) === "1") {
      await env.SYNC_STATE.delete(`bootstrapped:${acct.plaid_account_id}`);
      await env.SYNC_STATE.delete(`cursor:${acct.plaid_account_id}`);
    }
  }
  return normalized;
}

// Save both account identity and automation policy with one KV commit. Readers
// prefer this single bundle over the legacy split keys, so they can never observe
// a new account map paired with stale automation settings after a partial write.
export async function saveAccountConfiguration(env: Env, incomingAccounts: any[], incomingSettings: any[]): Promise<{ accounts: AccountConfig[]; settings: AccountAutomationSetting[] }> {
  const previousSettings = await getAccountAutomationSettings(env);
  const accounts = await saveAccountsMerged(env, incomingAccounts, false);
  const settings = await putAccountAutomationSettings(env, incomingSettings, accounts, false, false);

  // Prepare the existing "fresh bootstrap when sync is re-enabled" behavior
  // before the commit. If a reset fails, the old configuration remains active;
  // if the final bundle write fails, an early reset is harmless and repeatable.
  for (const acct of accounts) {
    const previous = previousSettings.find(s => s.nickname === acct.nickname);
    const wasOn = previous ? previous.sync_enabled : defaultSettingForAccount(acct.nickname).sync_enabled;
    const nowOn = settings.find(s => s.nickname === acct.nickname)?.sync_enabled;
    if (!wasOn && nowOn && (await env.SYNC_STATE.get(`bootstrapped:${acct.plaid_account_id}`)) === "1") {
      await env.SYNC_STATE.delete(`bootstrapped:${acct.plaid_account_id}`);
      await env.SYNC_STATE.delete(`cursor:${acct.plaid_account_id}`);
    }
  }
  await env.SYNC_STATE.put(ACCOUNT_CONFIG_BUNDLE_KEY, JSON.stringify({ version: 1, accounts, settings }, null, 2));
  return { accounts, settings };
}

// Two separate switches per account:
//   sync_enabled  - the worker may WRITE (sync, cleanups, Plaid refresh/webhooks).
//                   Off means the worker never changes the account, not even in a
//                   dry run.
//   audit_enabled - read-only health checks: Account health, Transaction reconcile
//                   and the bank-connection check. On by default, independent of sync.
export async function getAuditedAccounts(env: Env): Promise<AccountConfig[]> {
  const accounts = await getAccounts(env);
  const settings = await getAccountAutomationSettings(env);
  return accounts.filter(a => settingForAccount(settings, a).audit_enabled);
}

export async function getEnabledAccounts(env: Env): Promise<AccountConfig[]> {
  const accounts = await getAccounts(env);
  const settings = await getAccountAutomationSettings(env);
  return accounts.filter(a => settingForAccount(settings, a).sync_enabled);
}


export function settingForAccount(settings: AccountAutomationSetting[], acct: AccountConfig): AccountAutomationSetting {
  return settings.find(s => s.nickname === acct.nickname) || defaultSettingForAccount(acct.nickname);
}

export function isCreditCardAccount(acct: AccountConfig): boolean {
  if (typeof acct.is_credit_card === "boolean") return acct.is_credit_card;
  const n = acct.nickname.toLowerCase();
  // Explicit is_credit_card:true is the reliable signal (set it in ACCOUNT_MAP).
  // The nickname heuristic is a fallback so a card added without the flag still
  // routes: any nickname naming a known card (amex) or containing "card".
  return n.includes("amex") || n.includes("card");
}
