/**
 * YNAB Sync: a Cloudflare Worker that imports bank activity from Plaid into YNAB.
 *
 * Imports bank activity from Plaid into YNAB for each mapped account:
 *   - pending charges immediately, for an accurate "what can I spend" balance
 *   - each pending row flipped to cleared, in place, when the charge posts
 *   - posted charges exactly once, whichever feed saw them first
 *
 * One engine serves every account (see "SYNC ENGINE"). Each Plaid charge keeps a
 * single identity from pending through posted; the YNAB row it owns is found by
 * import id or a remembered link, never by guessing. Content matching (amount +
 * payee + date, one-to-one) is only a fallback for rows the worker didn't create:
 * manual entries and YNAB Direct Import. Where both exist, the non-worker row wins.
 *
 * Pending rows are retired only when the bank no longer shows them as pending
 * (verified against a 30-day Plaid window), never on age alone.
 *
 * Also: 15-minute cron with per-account frequency, verified Plaid webhooks, a
 * read-only audit and transaction reconcile that use the same matching as the
 * sync, skip rules, payee aliases, undo, and a dashboard with a dry-run toggle.
 * Every writing operation runs under one owner-tokened lock (Durable Object).
 *
 * This file is the entry point: HTTP routes, the cron, and the Durable Object export.
 * See docs/ARCHITECTURE.md for what lives where.
 */

import { auditAccounts } from "./audit/audit";
import { reconcileAllVsBank } from "./audit/reconcile";
import { DEFAULT_SKIP_RULES } from "./constants";
import { STUCK_LOG_KEY, getItemHealth, runItemHealthCheck, sendConnectionAlert, tracePendingRows } from "./health/items";
import { health, readJson } from "./health/status";
import { isSyncEnabled, lockedJson } from "./lock/lock";
import { plaidCall } from "./plaid/client";
import { debugPlaidRawTransactions, resetRunCache } from "./plaid/fetch";
import { configurePlaidWebhooks, forcePlaidRefresh, handlePlaidWebhook, refreshBeforeManualSync, verifyPlaidWebhook } from "./plaid/webhooks";
import { DEFAULT_PAYEE_ALIASES, getPayeeAliases, putPayeeAliases } from "./rules/payee-aliases";
import { getSkipRules, putSkipRules } from "./rules/skip-rules";
import { getTransferLabels, putTransferLabels } from "./rules/transfer-labels";
import { CONFIG_UNREADABLE, accountParam, cleanPaymentMatch, getAccountAutomationSettings, getAccounts, maskToken, migratePlaidAccountIdentity, putAccountAutomationSettings, putAccounts, saveAccountsMerged, settingForAccount } from "./store/accounts";
import { CONFIG_UNREADABLE, accountParam, cleanPaymentMatch, getAccountAutomationSettings, getAccounts, maskToken, migratePlaidAccountIdentity, putAccountAutomationSettings, putAccounts, saveAccountConfiguration, saveAccountsMerged, settingForAccount } from "./store/accounts";
import { resetCardEpoch } from "./store/card-epoch";
import { getEventLog } from "./store/event-log";
import { bootstrap } from "./sync/engine";
import { WORKER_PENDING_PREFIX, shortStableHash } from "./sync/matching";
import { accountIsDue, syncAll } from "./sync/run";
import { builtinPaymentMatch, roundMoney } from "./sync/transfers";
import { rollbackSync } from "./sync/undo";
import { Env } from "./types";
import { dashboardHtml } from "./ui/dashboard-page";
import { setupHtml } from "./ui/setup-page";
import { friendlyErrorMessage } from "./util/errors";
import { ADMIN_SESSION_COOKIE, NO_FRAMING, constantTimeEqual, createAdminSessionValue, json, requireAdmin } from "./util/http";
import { ynabGetAccount, ynabGetAccountTransactions, ynabGetAccounts, ynabGetDeletedAccountTransactions } from "./ynab/client";


// Durable Object classes must be exported from the main module.
export { SyncLock } from "./lock/sync-lock-do";

export const workerEntry = {
  // Every request goes through here: a saved configuration that can't be read is
  // answered with a plain message (what's wrong, how to fix it) on every endpoint,
  // instead of an unhandled exception.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    resetRunCache();
    try {
      return await workerEntry.routeFetch(req, env, ctx);
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      if (msg.startsWith(CONFIG_UNREADABLE)) return json({ ok: false, error: msg.replace(`${CONFIG_UNREADABLE}: `, ""), config_unreadable: true }, 409);
      return json({ ok: false, error: friendlyErrorMessage(e) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    resetRunCache();
    // Ask Plaid to re-poll the bank, but only for bank logins that have an enabled
    // account due to sync, and never while globally paused. When Plaid finds new data
    // it sends SYNC_UPDATES_AVAILABLE, and that webhook syncs the item's accounts
    // right away (it bypasses the frequency gate for that item).
    ctx.waitUntil((async () => {
      try {
        if (!(await isSyncEnabled(env))) return;
        const accounts = await getAccounts(env);
        const settings = await getAccountAutomationSettings(env);
        const tokens = new Set<string>();
        for (const a of accounts) {
          const setting = settingForAccount(settings, a);
          if (!setting.sync_enabled) continue;
          if ((await accountIsDue(env, a, setting)).due) tokens.add(a.plaid_access_token);
        }
        if (tokens.size > 0) await forcePlaidRefresh(env, "cron", [...tokens]);
      } catch {
        // Never let a refresh failure stop the sync below.
      }
    })());

    // Direct sync of whatever Plaid already has. The backstop if a webhook is late.
    ctx.waitUntil(syncAll(env, { trigger: "cron" }).catch(async (error: any) => {
      // A thrown error outside the per-account result handling (for example a
      // persistence or lock-service failure) must be visible to the dashboard.
      try {
        await env.SYNC_STATE.put("last_error", JSON.stringify({
          ts: new Date().toISOString(),
          errors: [{ account: "all", status: "error", error: String(error?.message || error), friendly_error: friendlyErrorMessage(error) }]
        }));
      } catch { /* the scheduled invocation still completes; next cron retries */ }
    }));
    // Item health self-throttles (every ~6h), so calling it each tick is cheap.
    ctx.waitUntil(runItemHealthCheck(env).catch(() => {}));
  },

  async routeFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);


    if (url.pathname === "/dashboard") return dashboardHtml();

    // Exchange the one-time admin token entered by the user for a browser session
    // held only in a Secure, HttpOnly, SameSite=Strict cookie. The token is never
    // written to Web Storage or returned to page JavaScript.
    if (url.pathname === "/session") {
      const origin = req.headers.get("Origin");
      if ((req.method === "POST" || req.method === "DELETE") && origin !== url.origin) {
        return json({ ok: false, error: "same-origin request required" }, 403);
      }
      if (req.method === "POST") {
        if (!env.ADMIN_TOKEN) return json({ ok: false, error: "ADMIN_TOKEN is not configured" }, 500);
        const supplied = req.headers.get("x-admin-token") || "";
        if (!supplied || !constantTimeEqual(supplied, env.ADMIN_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
        const sessionValue = await createAdminSessionValue(env.ADMIN_TOKEN);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`
          }
        });
      }
      if (req.method === "GET") {
        const unauthorized = await requireAdmin(req, env);
        if (unauthorized) return unauthorized;
        return json({ ok: true });
      }
      if (req.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
          }
        });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/webhook") {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

      // Read the raw body exactly once. We need the unparsed bytes to verify
      // Plaid's signature (it signs a SHA-256 of the raw body), and we reuse the
      // same string for parsing so there's no chance of a mismatch.
      // Plaid signs the exact raw body. Enforce a strict byte limit while
      // streaming so an oversized unauthenticated request cannot be fully buffered.
      const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
      const declaredLength = Number(req.headers.get("Content-Length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
        return json({ ok: false, error: "webhook payload too large" }, 413);
      }
      if (!req.body) return json({ ok: false, error: "webhook body required" }, 400);
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          totalBytes += part.value.byteLength;
          if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
            await reader.cancel();
            return json({ ok: false, error: "webhook payload too large" }, 413);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bodyBytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) { bodyBytes.set(chunk, offset); offset += chunk.byteLength; }
      const rawBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bodyBytes);
      const verification = req.headers.get("Plaid-Verification");
      const verified = await verifyPlaidWebhook(env, rawBody, verification);

      if (!verified) {
        // Fail closed: an unverified caller cannot trigger a sync. The 15-minute
        // cron is the backstop, so rejecting a bad webhook never loses data — it
        // just means that one push won't shortcut the schedule.
        return json({ ok: false, error: "webhook verification failed" }, 401);
      }

      const result = await handlePlaidWebhook(rawBody, env, ctx);
      return json(result);
    }

    // Browser sessions authenticate with an ambient HttpOnly cookie. Require an
    // exact same-origin Origin on every state-changing API request so a hostile
    // sibling subdomain or cross-site form cannot ride the cookie. Plaid's signed
    // webhook is intentionally handled above and is exempt from this browser check.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers.get("Origin") !== url.origin) {
      return json({ ok: false, error: "same-origin request required" }, 403);
    }

    if (url.pathname === "/health") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json(await health(env));
    }

    if (url.pathname === "/audit/accounts") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json(await auditAccounts(env, url));
    }


    if (url.pathname === "/undo") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      if (url.searchParams.get("confirm") === "true") {
        if (req.method !== "POST") return json({ error: "POST required to confirm undo" }, 405);
        return lockedJson(env, () => rollbackSync(env, url));
      }
      if (req.method !== "GET") return json({ error: "GET only for undo preview" }, 405);
      return json(await rollbackSync(env, url));
    }

    if (url.pathname === "/debug/plaid/raw") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json(await debugPlaidRawTransactions(env, url));
    }

    // Lists every account Plaid has for an item, using /accounts/get with NO
    // account_id filter — so it works even when the stored plaid_account_id is
    // wrong. Use this to find the correct account_id to put in the map.
    if (url.pathname === "/debug/plaid-accounts") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const nickname = url.searchParams.get("account");
      const acct = (await getAccounts(env)).find((a: any) => a.nickname === nickname);
      if (!acct) return json({ ok: false, error: `no account named ${nickname}` }, 400);
      try {
        const r = await plaidCall(env, "/accounts/get", { access_token: acct.plaid_access_token });
        return json({
          ok: true,
          nickname,
          stored_plaid_account_id: acct.plaid_account_id,
          accounts: (r.accounts || []).map((a: any) => ({
            account_id: a.account_id,
            name: a.name,
            mask: a.mask,
            subtype: a.subtype,
            type: a.type
          }))
        });
      } catch (e: any) {
        return json({ ok: false, nickname, error: e.message }, 500);
      }
    }

    if (url.pathname === "/reconcile") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const acct = url.searchParams.get("account") || undefined;
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 21));
      return json(await reconcileAllVsBank(env, days, acct));
    }

    if (url.pathname === "/debug/account-map") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;

      const accounts = await getAccounts(env);

      return json(
        accounts.map((a: any) => ({
          nickname: a.nickname,
          institution: a.institution || "",
          plaid_account_id: a.plaid_account_id,
          token_preview: maskToken(a.plaid_access_token),
          // Groups accounts that share one bank login, without revealing the token.
          login: a.item_id || `login-${shortStableHash(a.plaid_access_token || a.nickname)}`
        }))
      );
    }

    if (url.pathname === "/account-settings") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;

      // Read-only. Settings are saved together with the accounts via /accounts/save.
      if (req.method === "GET") return json({ settings: await getAccountAutomationSettings(env) });
      return json({ error: "GET only; save settings with /accounts/save" }, 405);
    }

    if (url.pathname === "/skip-rules") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;

      if (req.method === "GET") return json({ rules: await getSkipRules(env), defaults: DEFAULT_SKIP_RULES });

      if (req.method === "POST") {
        const body: any = await req.json();
        return lockedJson(env, async () => {
          const rules = await putSkipRules(env, body.rules || []);
          return { ok: true, rules };
        });
      }

      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/skip-rules/reset") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, async () => {
        await env.SYNC_STATE.delete("skip_rules");
        return { ok: true, rules: DEFAULT_SKIP_RULES };
      });
    }

    // NEW: Payee aliases — declare that differently-named transactions are the same
    // merchant, so dedup treats them as matches (e.g. an old brand name ↔ the new one).
    if (url.pathname === "/transfer-labels") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      if (req.method === "GET") return json({ labels: await getTransferLabels(env) });
      if (req.method === "POST") {
        const body: any = await req.json();
        return lockedJson(env, async () => ({ ok: true, labels: await putTransferLabels(env, body.labels || []) }));
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/payee-aliases") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;

      if (req.method === "GET") return json({ aliases: await getPayeeAliases(env), defaults: DEFAULT_PAYEE_ALIASES });

      if (req.method === "POST") {
        const body: any = await req.json();
        return lockedJson(env, async () => {
          const aliases = await putPayeeAliases(env, body.aliases || []);
          return { ok: true, aliases };
        });
      }

      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/sync") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const onlyAccount = await accountParam(env, url);
      if (onlyAccount === null) return json({ ok: false, error: `No mapped account named '${url.searchParams.get("account")}'.` }, 400);
      // Ask Plaid to go get fresh data from the bank first. Without this, Sync now
      // only reads Plaid's cached copy, which can be hours behind the bank's app.
      // The refresh is asynchronous: whatever it finds arrives as a webhook a few
      // minutes later and syncs on its own.
      const plaidRefresh = await refreshBeforeManualSync(env, onlyAccount);
      return json({ ...(await syncAll(env, { trigger: "manual", onlyAccount })), plaid_refresh: plaidRefresh });
    }

    if (url.pathname === "/dry-run") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const onlyAccount = await accountParam(env, url);
      if (onlyAccount === null) return json({ ok: false, error: `No mapped account named '${url.searchParams.get("account")}'.` }, 400);
      return json(await syncAll(env, { dryRun: true, trigger: "dry-run", onlyAccount }));
    }

    if (url.pathname === "/force-refresh") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json(await forcePlaidRefresh(env, url.origin));
    }

    if (url.pathname === "/backfill-recent") {
      if (req.method !== "GET" && req.method !== "POST") return json({ error: "GET or POST only" }, 405);
      if (req.method === "GET" && url.searchParams.get("dryRun") === "false") return json({ error: "POST required for a write-capable backfill" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      // Re-scan: re-check each account's import window for anything missing, without
      // moving the cursor. Honors the dry-run toggle, the global pause and each
      // account's own on/off switch.
      const dry = url.searchParams.get("dryRun") !== "false";
      const daysParam = Number(url.searchParams.get("days"));
      const backfillDays = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(30, Math.floor(daysParam)) : undefined;
      const onlyAccount = await accountParam(env, url);
      if (onlyAccount === null) return json({ ok: false, error: `No mapped account named '${url.searchParams.get("account")}'.` }, 400);
      return json(await syncAll(env, { trigger: "manual-rescan", backfillOnly: true, windowImport: "all", dryRun: dry, backfillDays, onlyAccount }));
    }

    if (url.pathname === "/configure-webhooks") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json(await configurePlaidWebhooks(env, url.origin));
    }

    if (url.pathname === "/bootstrap") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const accountId = url.searchParams.get("account");
      if (!accountId) return json({ error: "missing ?account=" }, 400);
      return lockedJson(env, () => bootstrap(env, accountId, undefined, url.searchParams.get("force") === "true"));
    }

    // Rotate a card's import-id epoch (see resetCardEpoch).
    if (url.pathname === "/reset-card") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, () => resetCardEpoch(env, url));
    }

    if (url.pathname === "/pause") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, async () => {
        await env.SYNC_STATE.put("sync:enabled", "false");
        return { ok: true, sync_enabled: false };
      });
    }

    if (url.pathname === "/resume") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, async () => {
        await env.SYNC_STATE.put("sync:enabled", "true");
        return { ok: true, sync_enabled: true };
      });
    }

    // NEW: Plaid Link token creation (for setup page)
    if (url.pathname === "/link-token") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      try {
        const body = await req.json() as any;
        const clientUserId = body.client_user_id || `setup-${Date.now()}`;
        const redirectUri = (env as any).PLAID_REDIRECT_URI || `${url.origin}/setup`;

        // Reconnect (update) mode: when a nickname is supplied we look up that bank's
        // stored access_token server-side and create an UPDATE-mode link token. This
        // repairs the existing Plaid item in place — same item_id, same account_ids,
        // same access_token — so a bank reauth needs no account-map changes.
        // No `products` field in update mode (that's only for new links).
        const params: any = {
          user: { client_user_id: clientUserId },
          client_name: "YNAB Sync Setup",
          country_codes: ["US"],
          language: "en",
          redirect_uri: redirectUri
        };
        if (body.nickname) {
          const acct = (await getAccounts(env)).find((a: any) => a.nickname === body.nickname);
          if (!acct || !acct.plaid_access_token) return json({ ok: false, error: `no stored token for ${body.nickname}` }, 400);
          params.access_token = acct.plaid_access_token; // update mode
        } else {
          params.products = ["transactions"]; // new link
        }

        const plaid = await plaidCall(env, "/link/token/create", params);

        return json({
          ok: true,
          link_token: plaid.link_token,
          expiration: plaid.expiration,
          mode: body.nickname ? "update" : "create"
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // Save account config and automation settings together, under the lock, so a
    // sync never sees one half of an edit.
    if (url.pathname === "/accounts/save") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const body = await req.json() as any;
      if (!Array.isArray(body.accounts) || !Array.isArray(body.settings)) return json({ ok: false, error: "Body must be { accounts: [...], settings: [...] }" }, 400);
      if (body.accounts.length === 0) return json({ ok: false, error: "Refusing to save an empty account list (did the list fail to load?). Nothing was changed." }, 400);
      return lockedJson(env, async () => {
        const saved = await saveAccountConfiguration(env, body.accounts, body.settings);
        return { ok: true, saved: saved.accounts.length, settings: saved.settings };
      });
    }

    // Explicit account-ID migration for the rare case Plaid cannot reconcile an
    // account ID. This is separate from ordinary settings saves and requires
    // operator confirmation that the new Plaid account is the same real account.
    if (url.pathname === "/accounts/migrate-plaid-id") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, async () => {
        const body = await req.json() as any;
        const nickname = String(body.nickname || "").trim().toLowerCase().replace(/\s+/g, "-");
        const linkId = String(body.link_id || "").trim();
        if (!nickname || !linkId || body.confirm_same_account !== true) {
          return { ok: false, error: "Provide nickname, link_id, and confirm_same_account: true after verifying the new bank account is the same real-world account." };
        }
        const pendingKey = "pending_link:" + linkId;
        const pending = await readJson(env, pendingKey, null);
        if (!pending?.access_token || !pending?.item_id) return { ok: false, error: "That bank link expired or is invalid. Link the bank again." };
        const current = (await getAccounts(env)).find(a => a.nickname === nickname);
        if (!current) return { ok: false, error: "No mapped account named " + nickname + "." };
        if (String(body.confirm_ynab_account_id || "") !== current.ynab_account_id) {
          return { ok: false, error: "confirm_ynab_account_id must exactly match the existing YNAB destination. Migration cannot change the YNAB account." };
        }
        const newPlaidAccountId = String(body.plaid_account_id || "").trim();
        if (!newPlaidAccountId) return { ok: false, error: "plaid_account_id is required." };
        const plaidAccounts = await plaidCall(env, "/accounts/get", { access_token: pending.access_token });
        if (!(plaidAccounts.accounts || []).some((a: any) => a.account_id === newPlaidAccountId)) {
          return { ok: false, error: "The selected Plaid account does not belong to the newly linked Item." };
        }
        const ynabAccounts = await ynabGetAccounts(env);
        if (!ynabAccounts.some((a: any) => a.id === current.ynab_account_id && !a.closed && !a.deleted)) {
          return { ok: false, error: "The existing YNAB destination is no longer active; migration was not performed." };
        }
        const result = await migratePlaidAccountIdentity(env, nickname, pending.access_token, newPlaidAccountId, pending.item_id, current.ynab_account_id);
        await env.SYNC_STATE.delete(pendingKey);
        return { ok: true, migration: result, note: "Previous Plaid-ID state was retained and account writes were paused. The new Plaid ID starts with a fresh cursor and bootstraps against the existing YNAB register. Run a dry run, verify the register and balances, then explicitly re-enable sync." };
      });
    }

    // Add-a-bank, step 1: exchange Plaid Link's public token. The access token is
    // kept server-side (KV, 1 hour) and never sent to the browser; the page gets a
    // pending link id plus the item's accounts to choose from.
    if (url.pathname === "/exchange-token") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      try {
        const body = await req.json() as any;
        if (!body.public_token) return json({ ok: false, error: "public_token required" }, 400);
        const ex = await plaidCall(env, "/item/public_token/exchange", { public_token: body.public_token });
        const accts = await plaidCall(env, "/accounts/get", { access_token: ex.access_token });
        const linkId = crypto.randomUUID();
        await env.SYNC_STATE.put(`pending_link:${linkId}`, JSON.stringify({ access_token: ex.access_token, item_id: ex.item_id }), { expirationTtl: 3600 });
        return json({
          ok: true,
          link_id: linkId,
          item_id: ex.item_id,
          accounts: (accts.accounts || []).map((a: any) => ({ account_id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype }))
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // Add-a-bank, step 2: add one account from a pending link to the account map.
    if (url.pathname === "/accounts/add") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return lockedJson(env, async () => {
        const body = await req.json() as any;
        const pending = await readJson(env, `pending_link:${body.link_id}`, null);
        if (!pending) return { ok: false, error: "That bank link expired (1 hour). Link the bank again." };
        const nickname = String(body.nickname || "").trim().toLowerCase().replace(/\s+/g, "-");
        const plaidAccountId = String(body.plaid_account_id || "").trim();
        const ynabAccountId = String(body.ynab_account_id || "").trim();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(nickname) || !plaidAccountId || !ynabAccountId) {
          return { ok: false, error: "Provide a valid nickname, Plaid account ID and YNAB account ID." };
        }
        if (typeof body.is_credit_card !== "boolean") return { ok: false, error: "is_credit_card must be a boolean." };
        // Verify the selected Plaid account against the server-side pending Item.
        const plaidAccounts = await plaidCall(env, "/accounts/get", { access_token: pending.access_token });
        if (!(plaidAccounts.accounts || []).some((a: any) => a.account_id === plaidAccountId)) {
          return { ok: false, error: "That Plaid account does not belong to the pending bank link." };
        }
        const ynabAccounts = await ynabGetAccounts(env);
        if (!ynabAccounts.some((a: any) => a.id === ynabAccountId && !a.closed && !a.deleted)) {
          return { ok: false, error: "Choose an active YNAB account from this budget." };
        }
        const accounts = await getAccounts(env);
        if (accounts.some(a => a.nickname === nickname)) return { ok: false, error: `An account named ${nickname} already exists` };
        if (accounts.some(a => a.plaid_account_id === plaidAccountId)) return { ok: false, error: "That bank account is already mapped" };
        accounts.push({
          nickname,
          institution: String(body.institution || ""),
          plaid_access_token: pending.access_token,
          plaid_account_id: plaidAccountId,
          ynab_account_id: ynabAccountId,
          item_id: pending.item_id,
          is_credit_card: !!body.is_credit_card,
          // A card's own last 4 is how checking-side payments usually name it.
          payment_match: body.is_credit_card ? cleanPaymentMatch({ last4: [String(body.mask || "")], words: [] }) : undefined
        });
        await saveAccountConfiguration(env, accounts, [{ nickname, sync_enabled: false }]);
        return { ok: true, added: nickname, note: "Added with sync OFF. Set its YNAB starting balance to the bank's posted balance, then turn its sync on in the dashboard (Settings)." };
      });
    }

    // YNAB accounts, for the add-a-bank picker.
    if (url.pathname === "/ynab-accounts") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const list = await ynabGetAccounts(env);
      return json({ ok: true, accounts: list.filter((a: any) => !a.closed && !a.deleted).map((a: any) => ({ id: a.id, name: a.name, type: a.type })) });
    }

    // Reconnect page: runs Plaid Link in update mode to repair a bank that says
    // "Needs reauth". Public HTML (no admin token needed to load the page); the
    // reconnect calls below carry the admin token the user pastes in. Handles the
    // OAuth redirect that Chase requires.
    if (url.pathname === "/setup") {
      return new Response(setupHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_FRAMING } });
    }
    // NEW: Account config management (KV-backed). Lets the dashboard read and
    // update accounts without editing wrangler.toml or redeploying.
    if (url.pathname === "/accounts") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;

      if (req.method === "GET") {
        const accounts = await getAccounts(env);
        // Never return raw tokens to the browser; show a masked preview instead.
        return json({
          ok: true,
          accounts: accounts.map(a => ({
            nickname: a.nickname,
            institution: a.institution || "",
            plaid_account_id: a.plaid_account_id,
            ynab_account_id: a.ynab_account_id,
            item_id: a.item_id || "",
            is_credit_card: !!a.is_credit_card,
            payment_match: a.payment_match || builtinPaymentMatch(a.nickname) || null,
            token_preview: maskToken(a.plaid_access_token),
            has_token: !!a.plaid_access_token
          }))
        });
      }

      // Saving goes through /accounts/save (accounts and settings together, locked).
      return json({ error: "GET only; save with /accounts/save" }, 405);
    }

    // NEW: Item health. GET returns the cached report; POST forces a fresh check.
    // Dump the YNAB register for one account (every row the worker sees), so stale
    // pending / phantom rows can be pinpointed without a manual CSV export.
    // For each uncleared row the worker created: what Plaid says about that charge
    // right now, and why it hasn't flipped to posted. Read-only.
    if (url.pathname === "/debug/stuck-pending") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      return json({ ok: true, entries: await readJson(env, STUCK_LOG_KEY, []) });
    }

    if (url.pathname === "/debug/pending-trace") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const nickname = url.searchParams.get("account");
      const acct = (await getAccounts(env)).find(a => a.nickname === nickname);
      if (!acct) return json({ ok: false, error: `Pick an account (no account named '${nickname || ""}').` }, 400);
      return json(await tracePendingRows(env, acct));
    }

    if (url.pathname === "/debug/ynab-history") {
      // The register (and every other view) only sees live rows. This asks YNAB for
      // the account's rows INCLUDING deleted ones, so a reconciled row that vanished
      // after you reconciled shows up here instead of silently moving the balance.
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const nickname = url.searchParams.get("account");
      if (!nickname) return json({ error: "missing ?account=" }, 400);
      const acct = (await getAccounts(env)).find(a => a.nickname === nickname);
      if (!acct) return json({ error: `no account named ${nickname}` }, 400);
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || 60)));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      // A delta request (last_knowledge_of_server) is the only way YNAB returns deleted rows.
      let all: any[];
      try { all = await ynabGetDeletedAccountTransactions(env, acct.ynab_account_id, since); }
      catch (e: any) { return json({ ok: false, error: e?.message || String(e) }, 502); }
      const origin = (r: any) => !r.import_id ? "entered by hand" : String(r.import_id).startsWith("YNAB:") ? "Direct Import" : /^(pcc|pcp|wp|ynab-sync)/i.test(String(r.import_id)) ? "worker" : "other import";
      const view = (r: any) => ({ id: r.id, date: r.date, payee: r.payee_name || "", amount: roundMoney(Number(r.amount || 0) / 1000), cleared: r.cleared, import_id: r.import_id || "", origin: origin(r), is_transfer: !!r.transfer_transaction_id, memo: r.memo || "" });
      const deleted = all.filter(r => r.deleted).map(view).sort((a, b) => (a.date < b.date ? 1 : -1));
      const sum = (xs: any[]) => roundMoney(xs.reduce((t, x) => t + x.amount, 0));
      const deletedLocked = deleted.filter(r => r.cleared === "reconciled");
      const deletedCleared = deleted.filter(r => r.cleared === "cleared");
      // Live balances come from the normal (non-delta) read of the FULL history: the
      // delta response can carry row versions the regular read doesn't, which threw
      // this total off by $349. Cleared-but-not-reconciled rows can be any age, so no
      // since_date here.
      const live = await ynabGetAccountTransactions(env, acct.ynab_account_id);
      const ya = await ynabGetAccount(env, acct.ynab_account_id).catch(() => null as any);
      const clearedBal = ya ? roundMoney(Number(ya.cleared_balance) / 1000) : null;
      const notReconciled = sum(live.filter(r => r.cleared === "cleared" && !(r as any).deleted).map(view));
      return json({
        ok: true, account: nickname, since,
        ynab_cleared_balance: clearedBal,
        cleared_not_yet_reconciled: notReconciled,
        reconciled_balance: clearedBal == null ? null : roundMoney(clearedBal - notReconciled),
        deleted_count: deleted.length,
        deleted_reconciled_count: deletedLocked.length,
        deleted_reconciled_total: sum(deletedLocked),
        deleted_cleared_total: sum(deletedCleared),
        deleted_reconciled: deletedLocked,
        deleted_cleared: deletedCleared,
        deleted_uncleared: deleted.filter(r => r.cleared === "uncleared"),
        note: "Deleted rows that were reconciled moved your reconciled balance after you reconciled. 'origin' is who CREATED the row, not who deleted it."
      });
    }

    if (url.pathname === "/debug/ynab-register") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const nickname = url.searchParams.get("account");
      if (!nickname) return json({ error: "missing ?account=" }, 400);
      const acct = (await getAccounts(env)).find(a => a.nickname === nickname);
      if (!acct) return json({ error: `no account named ${nickname}` }, 400);
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 30)));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const rows = await ynabGetAccountTransactions(env, acct.ynab_account_id, since);
      let clearedTotal = 0, unclearedTotal = 0;
      const out = rows.map(r => {
        const amt = Number(r.amount || 0) / 1000;
        if ((r.cleared || "") === "cleared" || r.cleared === "reconciled") clearedTotal += amt;
        else unclearedTotal += amt;
        return {
          id: r.id, date: r.date, payee: r.payee_name || "", amount: amt,
          cleared: r.cleared, memo: r.memo || "", import_id: r.import_id || "",
          is_worker_pending: (r.import_id || "").startsWith(WORKER_PENDING_PREFIX),
          is_transfer: !!r.transfer_transaction_id
        };
      });
      out.sort((a, b) => (a.date < b.date ? 1 : -1));
      return json({
        ok: true, account: nickname, since, row_count: out.length,
        cleared_total: Math.round(clearedTotal * 100) / 100,
        uncleared_total: Math.round(unclearedTotal * 100) / 100,
        working_total: Math.round((clearedTotal + unclearedTotal) * 100) / 100,
        rows: out
      });
    }

    // After a reconnect from /setup: clear Plaid's "login expiring soon" warning for
    // that bank and re-check its connection right away.
    if (url.pathname === "/reconnected") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const body = await req.json().catch(() => ({})) as any;
      const acct = (await getAccounts(env)).find(a => a.nickname === body.nickname);
      if (acct) {
        const itemId = acct.item_id || Object.values(await getItemHealth(env)).find(h => (h.nicknames || []).includes(acct.nickname))?.item_id;
        if (itemId) await env.SYNC_STATE.delete(`item_pending_expiration:${itemId}`);
      }
      const health = await runItemHealthCheck(env, true);
      const mine = Object.values(health).find(h => acct && (h.nicknames || []).includes(acct.nickname));
      return json({ ok: !mine || mine.status === "healthy", item: mine || null });
    }

    if (url.pathname === "/item-health") {
      if (req.method !== "GET" && req.method !== "POST") return json({ error: "GET or POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      // GET is strictly read-only; only an explicit POST may trigger checks/alerts.
      const health = req.method === "POST" ? await runItemHealthCheck(env, true) : await getItemHealth(env);
      return json({ ok: true, ts: new Date().toISOString(), items: Object.values(health) });
    }

    // Send a test alert email so you can confirm the Resend setup works without
    // waiting for a real connection to die. Uses a fake "broken" item.
    if (url.pathname === "/test-alert") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const configured = !!(env as any).RESEND_API_KEY && !!(env as any).ALERT_EMAIL_TO;
      if (!configured) {
        return json({
          ok: false,
          error: "Not configured. Set RESEND_API_KEY and ALERT_EMAIL_TO secrets first.",
          have_api_key: !!(env as any).RESEND_API_KEY,
          have_to_address: !!(env as any).ALERT_EMAIL_TO
        }, 400);
      }
      try {
        await sendConnectionAlert(env, [{
          item_id: "test", institution: "TEST BANK", nicknames: ["test-account"],
          status: "needs_reauth", last_check: new Date().toISOString(), error: "TEST_ALERT"
        }]);
        return json({ ok: true, note: "Test alert sent. Check your inbox (and spam)." });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // NEW: Structured event log (pending imports, gap-fills, retirements, etc).
    if (url.pathname === "/events") {
      const unauthorized = await requireAdmin(req, env);
      if (unauthorized) return unauthorized;
      const events = await getEventLog(env);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 200)));
      return json({ ok: true, events: events.slice(0, limit) });
    }

    return Response.redirect(`${url.origin}/dashboard`, 302);
  }
};
export default workerEntry;
