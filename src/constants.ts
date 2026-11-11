import { AccountAutomationSetting, SkipRule } from "./types";

export const ynabBudgetUrl = (budgetId: string) => `https://app.ynab.com/${encodeURIComponent(budgetId || "last-used")}/budget`;

// How far back the "import from the recent window" safety net looks, for every account.
export const IMPORT_WINDOW_DAYS = 7;
// Bootstrap catch-up starts this many days before the newest imported row in YNAB.
export const BOOTSTRAP_OVERLAP_DAYS = 3;
// Shown in the dashboard header and /health, so the running version is visible.
export const WORKER_VERSION = "1.0.0";
// Import window for accounts with "import from the recent window" on: the safety
// net that recovers a charge the cursor missed (e.g. while an account was paused).
// Ownership + one-to-one matching make the re-scan idempotent.
export const AUDIT_DAYS = 10;
// Balance discrepancies can be caused by older omitted transactions than the
// pending audit needs. Keep the normal audit window short, but search up to 30
// days when looking for transactions that explain a bank-vs-YNAB balance delta.
export const BALANCE_RECONCILIATION_DAYS = 30;
export const STALE_PENDING_DAYS = 3;
// Card payments DATED ON/AFTER this are turned into checking->card YNAB transfers.
// Anything before stays baked into the card's reconciled balance (no double-count).
// Set it to the day you start using this worker: the CC_TRANSFER_CUTOFF var, or KV
// "cc_transfer_cutoff" (KV wins). With neither, every card payment becomes a transfer.
export const CC_TRANSFER_CUTOFF_DEFAULT = "0000-01-01";

// How far back to read YNAB transactions for matching/detection. YNAB's API is
// capped at 200 requests/hour per token, and the old code pulled an account's
// ENTIRE history on every read. Pending charges clear within days, so a ~5-week
// window is more than enough for pending->posted matching and stale detection,
// while account *balances* (cleared/uncleared totals) now come straight from the
// account object instead of summing every transaction ever.
export const YNAB_LOOKBACK_DAYS = 35;
// The oldest charge the engine will ever write. Normally the YNAB snapshot covers the
// last YNAB_LOOKBACK_DAYS; when the bank replays older charges (a connection that was
// broken for weeks), the snapshot is widened to reach 5 days before the oldest one, up
// to this limit. Anything older is not created: it is logged for you to review, since
// it could not be checked against YNAB for a duplicate.
export const IDENTITY_HORIZON_DAYS = 120;
export const SNAPSHOT_MARGIN_DAYS = 5;
// A charge whose freshly minted import id YNAB keeps refusing is given up on after
// this many attempts (and logged), so it can't retry forever.
export const MAX_MINT_ATTEMPTS = 3;
// Don't re-run the full reconciliation audit on every 15-min sync — that reads
// every account's transactions repeatedly and burns the rate limit. Once an hour
// is plenty for a reconciliation report; the sync itself still runs every cron.
export const AUDIT_MIN_INTERVAL_MINUTES = 60;
export const DEFAULT_TIMEZONE = "UTC";   // set the TIMEZONE var to yours, e.g. "America/Chicago"

// Per-account defaults by nickname, used until you change an account's settings on the
// dashboard. Empty: every account starts with the defaults in store/accounts.ts.
export const DEFAULT_ACCOUNT_AUTOMATION_SETTINGS: AccountAutomationSetting[] = [];

// Allowed sync intervals (minutes). Cron fires every 15, so these are multiples.
export const SYNC_FREQUENCY_OPTIONS = [15, 30, 60, 120, 240];
export const DEFAULT_SYNC_FREQUENCY_MINUTES = 60;



// No built-in skip rules: every bank item that affects a balance is imported. Add your
// own on the dashboard (Rules), e.g. a paycheck you always enter by hand ahead of the bank.
export const DEFAULT_SKIP_RULES: SkipRule[] = [];
// Rule ids that are dropped from saved rules when read (for retiring old built-ins).
export const RETIRED_SKIP_RULE_IDS = new Set<string>();
