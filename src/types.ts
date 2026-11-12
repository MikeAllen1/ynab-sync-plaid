import { LogEvent } from "./store/event-log";

export interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  YNAB_TOKEN: string;
  ADMIN_TOKEN: string;

  PLAID_ENV: string;
  YNAB_BUDGET_ID: string;
  ACCOUNT_MAP: string;

  SYNC_STATE: KVNamespace;

  // Durable Object namespace backing the atomic sync mutex and transactional
  // diagnostic-history appends. Financial writes fail closed when it is absent.
  SYNC_LOCK?: DurableObjectNamespace;

  // Optional. If set, the Worker POSTs a JSON alert here when sync health
  // changes state (e.g. healthy -> error, or recovers). No-op when unset.
  ALERT_WEBHOOK_URL?: string;
  // Optional. IANA timezone used for calendar-day math (stale-pending aging).
  // Defaults to UTC; set it so day boundaries match your local time.
  TIMEZONE?: string;
  // Optional. YYYY-MM-DD: card payments before this stay in the card's starting
  // balance instead of becoming transfers (see constants.ts).
  CC_TRANSFER_CUTOFF?: string;
  // Optional. "off" stops asking Plaid to re-check banks (/transactions/refresh), which
  // paid Plaid plans bill per call. Default: on.
  PLAID_REFRESH?: string;
}

export interface AccountConfig {
  plaid_access_token: string;
  plaid_account_id: string;
  ynab_account_id: string;
  nickname: string;
  // Optional explicit flag. When omitted, falls back to a nickname heuristic.
  is_credit_card?: boolean;
  // Plaid Item id + institution name, captured at link time. Used for item-health
  // monitoring and to group accounts that share one bank login (one Item).
  item_id?: string;
  institution?: string;
  // Credit cards only: how a checking-side payment names this card (last 4 digits
  // and/or words such as "sapphire"). Edited in Settings. When absent, the built-in
  // rule for the nickname (none by default) is used.
  payment_match?: { last4: string[]; words: string[] };
}

export interface ItemHealth {
  item_id: string;
  institution: string;
  nicknames: string[];
  status: "healthy" | "needs_reauth" | "error" | "stale" | "unknown";
  last_check: string | null;
  error: string | null;
  // When Plaid last got fresh data from the bank (from /item/get).
  last_bank_update?: string | null;
  // The alert email for this problem failed to send; it is retried on the next check.
  alert_failed?: boolean;
}

export interface PlaidTransaction {
  transaction_id: string;
  pending_transaction_id: string | null;
  account_id: string;
  amount: number;
  iso_currency_code: string;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  // Plaid's categorization, used to reliably identify transfers / card payments
  // (e.g. LOAN_PAYMENTS, TRANSFER_OUT) regardless of the bank's free-text name.
  pfc_primary?: string | null;
  pfc_detailed?: string | null;
}

// Flatten a raw Plaid transaction (from /transactions/sync or /get) into our shape,
// hoisting personal_finance_category.primary/detailed to pfc_primary/pfc_detailed.
// All category-based logic (classifyTransfer, fuzzyTwin tip tolerance) depends on
// these flattened fields, so every feed must pass through here.
export function normalizePlaidTxn(t: any): PlaidTransaction {
  if (!t || typeof t.transaction_id !== "string" || !t.transaction_id ||
      typeof t.account_id !== "string" || !t.account_id ||
      typeof t.amount !== "number" || !Number.isFinite(t.amount) ||
      typeof t.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) ||
      typeof t.pending !== "boolean") {
    throw new Error("Plaid transaction is missing required identity, amount, date, or pending fields.");
  }
  // YNAB stores milliunits and the worker does not perform FX conversion. Never
  // invent USD when Plaid supplies no ISO currency or silently round beyond the
  // destination's three-decimal precision.
  if (typeof t.iso_currency_code !== "string" || !/^[A-Z]{3}$/.test(t.iso_currency_code)) {
    throw new Error(`Plaid transaction ${t.transaction_id} has no supported ISO currency code; it was not imported.`);
  }
  if (Math.abs(t.amount * 1000 - Math.round(t.amount * 1000)) > 1e-7) {
    throw new Error(`Plaid transaction ${t.transaction_id} exceeds YNAB milliunit precision; it was not imported.`);
  }
  return {
    transaction_id: t.transaction_id,
    pending_transaction_id: typeof t.pending_transaction_id === "string" ? t.pending_transaction_id : null,
    account_id: t.account_id,
    amount: t.amount,
    iso_currency_code: t.iso_currency_code,
    date: t.date,
    authorized_date: typeof t.authorized_date === "string" ? t.authorized_date : null,
    name: typeof t.name === "string" && t.name ? t.name : "Unknown",
    merchant_name: typeof t.merchant_name === "string" ? t.merchant_name : null,
    pending: t.pending,
    pfc_primary: t.pfc_primary ?? t.personal_finance_category?.primary ?? null,
    pfc_detailed: t.pfc_detailed ?? t.personal_finance_category?.detailed ?? null
  };
}

// A Plaid row the worker can't safely represent (no ISO currency, more precision
// than YNAB's milliunits, missing identity fields). It is set aside and reported
// instead of failing the whole account: one bad row must never stop every other
// charge on the account from syncing, or pin its bank cursor.
export interface QuarantinedPlaidTxn {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number | null;
  name: string;
  reason: string;
}

export function partitionPlaidTxns(rows: any[]): { transactions: PlaidTransaction[]; quarantined: QuarantinedPlaidTxn[] } {
  const transactions: PlaidTransaction[] = [];
  const quarantined: QuarantinedPlaidTxn[] = [];
  for (const raw of rows || []) {
    try {
      transactions.push(normalizePlaidTxn(raw));
    } catch (e: any) {
      quarantined.push({
        transaction_id: typeof raw?.transaction_id === "string" ? raw.transaction_id : "",
        account_id: typeof raw?.account_id === "string" ? raw.account_id : "",
        date: typeof raw?.date === "string" ? raw.date : "",
        amount: typeof raw?.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : null,
        name: typeof raw?.merchant_name === "string" && raw.merchant_name ? raw.merchant_name : typeof raw?.name === "string" ? raw.name : "",
        reason: String(e?.message || e)
      });
    }
  }
  return { transactions, quarantined };
}

export interface YNABTransaction {
  account_id: string;
  date: string;
  amount: number;
  payee_name: string;
  cleared: "cleared" | "uncleared";
  approved: boolean;
  import_id: string;
  memo?: string;
  // When set, YNAB treats this as a transfer to the account whose transfer payee
  // this is, and auto-creates the paired leg. Used for checking -> card payments.
  payee_id?: string | null;
}

export interface YNABExistingTransaction {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  payee_name?: string;
  category_id?: string | null;
  memo?: string | null;
  cleared?: "cleared" | "uncleared" | "reconciled";
  approved?: boolean;
  import_id?: string | null;
  transfer_transaction_id?: string | null;
  transfer_account_id?: string | null;
}

export interface YNABAccountSummary {
  id: string;
  name: string;
  type?: string;
  transfer_payee_id?: string | null;
}

export interface SyncOptions {
  dryRun?: boolean;
  trigger?: string;
  backfillOnly?: boolean;
  backfillDays?: number;
  accountSetting?: AccountAutomationSetting;
  // Optional in-run collector for structured events; flushed once per sync.
  events?: LogEvent[];
  // See syncAccountEngine. Re-scan passes "all".
  windowImport?: "all" | "pending" | "none";
  // Plaid item that sent a SYNC_UPDATES_AVAILABLE webhook: its accounts skip the
  // frequency gate (with a 2-minute floor), since the data just landed.
  webhookItemId?: string;
  // Restrict a manual run to one account (the dashboard's Account selector).
  onlyAccount?: string;
  // Groups the undo entries this run records, so one run is one undo entry.
  runId?: string;
  // Bootstrap preview: the catch-up floor to use instead of the saved bootstrap date.
  importFloor?: string;
}

export interface AccountAutomationSetting {
  nickname: string;
  sync_enabled: boolean;
  backfill_enabled: boolean;
  // How often this account should sync, in minutes. The cron fires every 15 min;
  // an account only actually syncs when its own interval has elapsed since its
  // last sync. Lets low-velocity accounts (checking) poll less than a busy credit card.
  sync_frequency_minutes: number;
  // Read-only health checks (Account health, Transaction reconcile, connection
  // check). Independent of sync: an account can be audited while the worker never
  // writes to it (e.g. an account YNAB Direct Import already feeds).
  audit_enabled: boolean;
}

export interface SkippedIncomeRecord {
  ts: string;
  account: string;
  payee: string;
  amount: number;
  date: string;
  reason: string;
}

export interface SkipRule {
  id: string;
  enabled: boolean;
  account: string;
  contains: string;
  transaction_type: "inflow" | "outflow" | "any";
  amounts?: number[];
  reason: string;
}
