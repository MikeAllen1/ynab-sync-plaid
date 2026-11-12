// Browser tests: a made-up household (no real data) in the shapes the worker's
// endpoints return. Times are relative to now so "ago" labels stay stable.

const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

export const ACCOUNTS = [
  { nickname: "joint-checking", institution: "Chase", plaid_account_id: "p-chk", ynab_account_id: "y-chk", item_id: "item-chase", is_credit_card: false, payment_match: null, token_preview: "access-…a1f3", has_token: true },
  { nickname: "sapphire", institution: "Chase", plaid_account_id: "p-sap", ynab_account_id: "y-sap", item_id: "item-chase", is_credit_card: true, payment_match: { last4: ["4417"], words: ["sapphire"] }, token_preview: "access-…a1f3", has_token: true },
  { nickname: "amex", institution: "American Express", plaid_account_id: "p-amex", ynab_account_id: "y-amex", item_id: "item-amex", is_credit_card: true, payment_match: { last4: ["1009"], words: [] }, token_preview: "access-…77c0", has_token: true },
  { nickname: "ally-savings", institution: "Ally Bank", plaid_account_id: "p-ally", ynab_account_id: "y-ally", item_id: "item-ally", is_credit_card: false, payment_match: null, token_preview: "access-…0b9e", has_token: true },
];

export const SETTINGS = [
  { nickname: "joint-checking", sync_enabled: true, backfill_enabled: true, sync_frequency_minutes: 15, audit_enabled: true },
  { nickname: "sapphire", sync_enabled: true, backfill_enabled: true, sync_frequency_minutes: 15, audit_enabled: true },
  { nickname: "amex", sync_enabled: true, backfill_enabled: true, sync_frequency_minutes: 30, audit_enabled: true },
  { nickname: "ally-savings", sync_enabled: false, backfill_enabled: false, sync_frequency_minutes: 60, audit_enabled: true },
];

const audit = (account: string, extra: any = {}) => ({
  account, status: "healthy", bank_balance: 0, ynab_balance: 0, balance_difference: 0, unexplained_difference: 0,
  pending_purchase_count_total: 0, pending_purchase_count_covered: 0, worker_pending_count: 0, checked_at: min(20),
  balance_source: "Plaid balance (posted, adjusted for pending)", warnings: [], notes: [], ...extra,
});

export function health(over: any = {}) {
  const statuses = {
    "joint-checking": { level: "ok", label: "Healthy", secondary: "", tracked: true },
    sapphire: { level: "warn", label: "Known difference", secondary: "", tracked: true },
    amex: { level: "bad", label: "Needs reconnect", secondary: "", tracked: true },
    "ally-savings": { level: "ok", label: "Healthy", secondary: "Worker sync off (health-checked)", tracked: true },
  };
  return {
    ok: true, health_status: "warning", attention_level: "bad", sync_enabled: true, now: new Date().toISOString(),
    last_success: { ts: min(9) }, last_error: null, skipped_income_history: [
      { date: day(3), account: "joint-checking", payee: "ACME CORP PAYROLL", reason: "Entered manually in YNAB", amount: 2650 },
    ],
    attention: [
      { level: "bad", text: "Amex: the bank connection needs to be reconnected (ITEM_LOGIN_REQUIRED). Use Reconnect on its row." },
      { level: "warn", text: "Sapphire: 1 pending charge the bank still lists isn't in YNAB yet (as of the check at 8:05 AM; Re-check after fixing it)." },
    ],
    account_statuses: statuses,
    last_account_audit: {
      ts: min(20), worker_version: "1.0.0",
      audits: [
        audit("joint-checking", { bank_balance: 4210.55, ynab_balance: 4210.55, plaid_pending_count: 2, pending_purchase_count_total: 2, pending_purchase_count_covered: 2, worker_pending_count: 2 }),
        audit("sapphire", { status: "warning", bank_balance: -982.06, ynab_balance: -975.61, balance_difference: 6.45, explained_difference: 6.45, unexplained_difference: 0, explained_by: "1 pending charge at the bank isn't in YNAB yet", plaid_pending_count: 3, pending_purchase_count_total: 3, pending_purchase_count_covered: 2, worker_pending_count: 2 }),
        audit("amex", { status: "warning", audit_unavailable: true, bank_balance: null, ynab_balance: -311.2, unexplained_difference: null, warnings: ["Plaid needs the bank login again."] }),
        audit("ally-savings", { bank_balance: 12000, ynab_balance: 12000 }),
      ],
      summary: { healthy: 2, warning: 2, needs_attention: 0 },
    },
    worker_version: "1.0.0",
    status: {
      accounts: [
        { nickname: "joint-checking", bootstrapped: true, last_account_sync: min(9), next_due_minutes: 6, overdue: false, automation: SETTINGS[0] },
        { nickname: "sapphire", bootstrapped: true, last_account_sync: min(9), next_due_minutes: 6, overdue: false, automation: SETTINGS[1] },
        { nickname: "amex", bootstrapped: true, last_account_sync: min(190), next_due_minutes: 0, overdue: false, automation: SETTINGS[2] },
        { nickname: "ally-savings", bootstrapped: true, last_account_sync: null, next_due_minutes: 0, overdue: false, automation: SETTINGS[3] },
      ],
    },
    ...over,
  };
}

export const EVENTS = [
  { ts: min(9), account: "sapphire", action: "pending_import", amount: -142850, detail: "OLIVE GARDEN #1123 · pending", transaction_id: "y1" },
  { ts: min(9), account: "joint-checking", action: "pending_flip", amount: -118470, detail: "WALMART SUPERCENTER posted", transaction_id: "y2" },
  { ts: min(70), account: "joint-checking", action: "matched_existing_row", amount: -1450000, detail: "ROCKET MORTGAGE → your row Rocket Mortgage", transaction_id: "y3" },
  { ts: min(70), account: "sapphire", action: "matched_by_amount_only", amount: -6450, detail: "SQ *BLUE BOTTLE → your row Coffee", transaction_id: "y4" },
  { ts: min(130), account: "joint-checking", action: "card_payment_transfer", amount: -1112160, detail: "CHASE CREDIT CRD AUTOPAY → Transfer : Sapphire" },
  { ts: min(190), account: "amex", action: "update_failed", amount: -45000, detail: "YNAB said 429: too many requests", transaction_id: "y5" },
];

export const ITEMS = [
  { item_id: "item-chase", institution: "Chase", nicknames: ["joint-checking", "sapphire"], status: "healthy", last_check: min(40), last_bank_update: min(55) },
  { item_id: "item-amex", institution: "American Express", nicknames: ["amex"], status: "needs_reauth", last_check: min(40), error: "ITEM_LOGIN_REQUIRED" },
  { item_id: "item-ally", institution: "Ally Bank", nicknames: ["ally-savings"], status: "healthy", last_check: min(40), last_bank_update: min(300) },
];

export const UNDO_LIST = {
  ok: true,
  runs: [
    { index: 0, ts: min(9), trigger: "cron", count: 1 },
    { index: 1, ts: min(70), trigger: "webhook", count: 3 },
    { index: 2, ts: min(130), trigger: "manual", count: 2 },
  ],
};

export const YNAB_ACCOUNTS = [
  { id: "y-chk", name: "Joint Checking", type: "checking" },
  { id: "y-sap", name: "Chase Sapphire", type: "creditCard" },
  { id: "y-amex", name: "Amex Blue Cash", type: "creditCard" },
  { id: "y-ally", name: "Ally Savings", type: "savings" },
  { id: "y-cap", name: "Capital One Venture", type: "creditCard" },
];
