import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPlaidSyncDeltas } from "../src/sync/engine";

const env: any = { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" };
const account: any = { plaid_access_token: "access", plaid_account_id: "account-1" };
const row = (id: string) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: "account-1",
  amount: 10,
  iso_currency_code: "USD",
  date: "2026-11-10",
  authorized_date: null,
  name: "Test merchant",
  merchant_name: "Test merchant",
  pending: false
});
const ok = (added: any[], next_cursor: string, has_more: boolean) =>
  new Response(JSON.stringify({ added, modified: [], removed: [], next_cursor, has_more }), { status: 200 });
const mutation = () => new Response(JSON.stringify({
  error_type: "TRANSACTIONS_ERROR",
  error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
  error_message: "Transactions changed during pagination",
  request_id: "request"
}), { status: 400 });

test("Plaid mutation during pagination restarts from the original cursor and discards partial pages", async () => {
  const original = globalThis.fetch;
  const cursors: string[] = [];
  const pages = [
    ok([row("discard-me")], "partial-cursor", true),
    mutation(),
    ok([row("keep-a")], "next-cursor", true),
    ok([row("keep-b")], "final-cursor", false)
  ];
  let index = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    cursors.push(JSON.parse(String(init?.body)).cursor);
    return pages[index++];
  }) as typeof fetch;
  try {
    const batch = await fetchPlaidSyncDeltas(env, account, "original-cursor");
    assert.deepEqual(cursors, ["original-cursor", "partial-cursor", "original-cursor", "next-cursor"]);
    assert.deepEqual(batch.added.map(t => t.transaction_id), ["keep-a", "keep-b"]);
    assert.equal(batch.cursor, "final-cursor");
  } finally {
    globalThis.fetch = original;
  }
});

test("Plaid cursor pagination fails after the bounded full-batch restart limit", async () => {
  const original = globalThis.fetch;
  const cursors: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    cursors.push(JSON.parse(String(init?.body)).cursor);
    call++;
    return call % 2 === 1 ? ok([row("discard-" + call)], "partial-" + call, true) : mutation();
  }) as typeof fetch;
  try {
    await assert.rejects(fetchPlaidSyncDeltas(env, account, "stable-cursor"), /TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION/);
    assert.equal(cursors.length, 8);
    assert.deepEqual(cursors.filter((_, i) => i % 2 === 0), Array(4).fill("stable-cursor"));
  } finally {
    globalThis.fetch = original;
  }
});
