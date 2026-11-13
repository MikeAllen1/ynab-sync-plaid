import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, runCron } from "./sim/world";
import { workerEntry } from "../src/index";
import { withDurableAccountState } from "../src/store/durable-state";
import { getUndoLog } from "../src/sync/undo";

// A checking -> card payment is created as a YNAB transfer, then both legs are verified.
// The simulated YNAB doesn't pair transfers, so verification fails: exactly the case
// where the worker used to throw BEFORE recording which rows it had just created.
test("a failed transfer verification still records the row it created (pins + undo)", async () => {
  const w = makeWorld({ accounts: 3, history: 0 });
  const accts = JSON.parse((w.env as any).ACCOUNT_MAP);
  accts[2].payment_match = { last4: ["4321"], words: [] };
  (w.env as any).ACCOUNT_MAP = JSON.stringify(accts);
  const restore = w.install();
  try {
    await runCron(workerEntry, w.env);               // first run sets every account up
    const pay = w.addPlaid(w.accounts[0], w.today, 250, "CHASE CREDIT CARD PAYMENT ENDING 4321");
    (pay as any).personal_finance_category = { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
    w.changeLog.push({ kind: "added", t: pay });
    for (const k of [...w.kvData.keys()]) if (k.startsWith("last_account_sync:")) w.kvData.delete(k);
    const env = withDurableAccountState(w.env);
    for (const a of w.accounts) await env.SYNC_STATE.delete(`last_account_sync:${a.plaid_account_id}`);

    await runCron(workerEntry, w.env);
    const created = w.activeYnabRows().filter(r => r.account_id === "ynab-1" && r.amount === -250000);
    assert.equal(created.length, 1, "the transfer row was written to YNAB");
    const lastError = JSON.parse(w.kvData.get("last_error") || "{}");
    assert.match(JSON.stringify(lastError), /transfer verification failed/i, "the run reports the failed verification");

    // Recorded before verification: the undo list has the row...
    const undo = await getUndoLog(env);
    assert.ok(undo.some(b => b.items.some(i => i.id === created[0].id)), "the created row is in the undo log");
    // ...and nothing waits on a stale intent.
    assert.equal(await env.SYNC_STATE.get("undo_intent:plaid-1"), null);

    // The next run (YNAB now pairs it properly) doesn't book the payment a second time.
    created[0].transfer_transaction_id = "leg-x"; created[0].transfer_account_id = "ynab-3";
    w.ynabRows.push({ id: "leg-x", account_id: "ynab-3", date: w.today, amount: 250000, payee_id: "tp-ynab-1", cleared: "cleared", approved: true, import_id: null, deleted: false, transfer_transaction_id: created[0].id, transfer_account_id: "ynab-1", subtransactions: [] });
    for (const a of w.accounts) await env.SYNC_STATE.delete(`last_account_sync:${a.plaid_account_id}`);
    await runCron(workerEntry, w.env);
    assert.equal(w.activeYnabRows().filter(r => r.account_id === "ynab-1" && r.amount === -250000).length, 1, "no duplicate payment");
  } finally { restore(); }
});
