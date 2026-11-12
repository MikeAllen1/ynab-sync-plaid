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
    const result = await fetchRawWindow(env, account, 30, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.transactions.length, 0);
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

test("Plaid transaction history rejects a changing total across pages", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      transactions: [{ transaction_id: "tx-" + calls, account_id: "plaid-account", date: "2026-11-11", amount: 12 }],
      total_transactions: calls === 1 ? 2 : 3
    });
  };
  try {
    const result = await fetchRawWindow(env, account, 30, 1);
    assert.equal(result.truncated, true, "a changing total must never be treated as a complete snapshot");
    assert.equal(result.transactions.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("Plaid transaction history rejects duplicate records across pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    transactions: [{ transaction_id: "same-tx", account_id: "plaid-account", date: "2026-11-11", amount: 12 }],
    total_transactions: 2
  });
  try {
    const result = await fetchRawWindow(env, account, 30, 1);
    assert.equal(result.truncated, true, "duplicate rows across pages make the snapshot untrusted");
  } finally { globalThis.fetch = originalFetch; }
});
