import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRawWindow } from "../src/plaid/fetch";
import type { Env, AccountConfig } from "../src/types";

const env = {
  PLAID_ENV: "production",
  PLAID_CLIENT_ID: "client",
  PLAID_SECRET: "secret"
} as Env;
const account = {
  nickname: "checking",
  plaid_access_token: "access",
  plaid_account_id: "plaid-account",
  ynab_account_id: "ynab-account"
} as AccountConfig;

test("Plaid transaction history rejects missing pagination collections", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ total_transactions: 0 });
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 100), /invalid page/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid transaction history rejects empty pages before the reported total", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ transactions: [], total_transactions: 1 });
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 100), /empty page before total_transactions/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid transaction history rejects malformed transaction rows", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    transactions: [{ transaction_id: "tx", account_id: "plaid-account", date: "2026-11-11", amount: "12.00" }],
    total_transactions: 1
  });
  try {
    await assert.rejects(fetchRawWindow(env, account, 30, 100), /malformed transaction/);
  } finally { globalThis.fetch = originalFetch; }
});
