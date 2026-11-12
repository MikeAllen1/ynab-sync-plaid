import type { AccountConfig, PlaidTransaction } from "../src/types";
import type { RoutingContext } from "../src/sync/engine";

let nextTestTransactionId = 0;

/** A Plaid transaction. Plaid's sign: positive = money out, negative = money in. */
export function txn(o: Partial<PlaidTransaction> & { name: string; amount: number }): PlaidTransaction {
  return {
    transaction_id: o.transaction_id ?? `test-tx-${++nextTestTransactionId}`,
    pending_transaction_id: null, account_id: "acct-checking", iso_currency_code: "USD",
    date: "2026-03-10", authorized_date: null, merchant_name: null, pending: false,
    pfc_primary: null, pfc_detailed: null, ...o,
  };
}

export const checking: AccountConfig = { nickname: "checking", plaid_access_token: "access-a", plaid_account_id: "acct-checking", ynab_account_id: "ynab-checking", institution: "First Bank" };
export const savings: AccountConfig = { nickname: "savings", plaid_access_token: "access-b", plaid_account_id: "acct-savings", ynab_account_id: "ynab-savings", institution: "Other Bank" };
export const visa: AccountConfig = { nickname: "rewards-card", is_credit_card: true, plaid_access_token: "access-a", plaid_account_id: "acct-visa", ynab_account_id: "ynab-visa", institution: "Chase", payment_match: { last4: ["4321"], words: ["sapphire"] } };
export const amex: AccountConfig = { nickname: "amex", is_credit_card: true, plaid_access_token: "access-c", plaid_account_id: "acct-amex", ynab_account_id: "ynab-amex", institution: "American Express", payment_match: { last4: ["9876"], words: ["american express", "amex"] } };

export function ctx(o: Partial<RoutingContext> = {}): RoutingContext {
  return {
    accounts: [checking, savings, visa, amex], settings: [],
    cardPayeeByNickname: { "rewards-card": "payee-visa", amex: "payee-amex" },
    accountPayeeByNickname: { checking: "payee-checking", savings: "payee-savings", "rewards-card": "payee-visa", amex: "payee-amex" },
    masks: { "acct-checking": "1111", "acct-savings": "2222", "acct-visa": "4321", "acct-amex": "9876" }, masksMissing: [],
    cutoff: "0000-01-01", ok: true, aliases: [], transferLabels: [], ...o,
  };
}
