import { lookbackDate } from "../plaid/fetch";
import { getAccounts } from "../store/accounts";
import { isWorkerImportPrefix } from "./engine";
import { Env, YNABExistingTransaction } from "../types";
import { ynabDeleteTransaction, ynabGetAccountTransactions } from "../ynab/client";

// ---------- Undo / rollback ----------
//
// Every non-dry sync records the exact YNAB transaction ids it CREATED, grouped by
// run. /undo deletes precisely those rows and nothing else — never a manual entry,
// a Direct Import row, or anything from a different run. It undoes creates only
// (the "a sync dumped a bunch in" case); it does not resurrect rows a sync deleted.
// The last UNDO_LOG_MAX runs that created anything are kept, newest first, so you
// can undo more than just the most recent if needed.

export const UNDO_LOG_KV_KEY = "undo_log";
export const UNDO_LOG_MAX = 10;

export interface UndoBatch {
  ts: string;
  trigger: string;
  run_id?: string;
  count: number;
  items: { id: string; account: string; amount?: number; import_id?: string }[];
}

export async function getUndoLog(env: Env): Promise<UndoBatch[]> {
  try {
    const raw = await env.SYNC_STATE.get(UNDO_LOG_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

// Called by the engine the moment YNAB accepts new rows, so even a run that fails
// later (an update refused, a timeout) can be undone. Accounts in the same run share
// one entry.
export async function appendUndo(env: Env, runId: string, trigger: string, items: UndoBatch["items"]): Promise<void> {
  const existing = await getUndoLog(env);
  const head = existing[0];
  if (head && head.run_id === runId) {
    head.items.push(...items);
    head.count = head.items.length;
  } else {
    existing.unshift({ ts: new Date().toISOString(), trigger, run_id: runId, count: items.length, items });
  }
  await env.SYNC_STATE.put(UNDO_LOG_KV_KEY, JSON.stringify(existing.slice(0, UNDO_LOG_MAX)));
}

// Undo endpoint. Safe by default:
//   GET /undo                      -> preview the most recent run's creations (no delete)
//   GET /undo?list=true            -> list the last few undoable runs
//   GET /undo?ts=T&confirm=true    -> delete the rows of the run recorded at T (the
//                                     timestamp is required, so a run recorded
//                                     meanwhile can't be deleted by mistake)
export async function rollbackSync(env: Env, url: URL): Promise<any> {
  const history = await getUndoLog(env);

  if (url.searchParams.get("list") === "true") {
    return {
      ok: true,
      runs: history.map((b, i) => ({ index: i, ts: b.ts, trigger: b.trigger, count: b.count }))
    };
  }

  if (history.length === 0) {
    return { ok: true, nothing_to_undo: true, message: "No sync-created transactions are on record to undo." };
  }

  let idx = 0;
  const idxParam = url.searchParams.get("index");
  if (idxParam !== null && idxParam !== "" && Number.isFinite(Number(idxParam))) idx = Number(idxParam);
  // Identify the run by its timestamp when given. The list shifts whenever a new
  // sync is recorded, so a position alone could point at a different run than the
  // one previewed; a timestamp that no longer exists is refused, never guessed.
  const tsParam = url.searchParams.get("ts");
  if (tsParam) {
    const found = history.findIndex(b => b.ts === tsParam);
    if (found < 0) return { ok: false, error: "That sync is no longer in the undo list (it was already undone or aged out). Nothing was deleted." };
    idx = found;
  } else if (url.searchParams.get("confirm") === "true") {
    return { ok: false, error: "Undo needs the run's timestamp (&ts=...) so it can't delete a different sync than the one you previewed. Nothing was deleted." };
  }

  const batch = history[idx];
  if (!batch) return { ok: false, error: `No undo run at index ${idx}. Use ?list=true to see options.` };

  // Look at each created row as it is NOW. A pending row that has since settled
  // (flipped to cleared), or anything reconciled, is a real transaction now and is
  // left alone. Rows already gone are skipped.
  const accounts = await getAccounts(env);
  const current = new Map<string, YNABExistingTransaction>();
  for (const nick of [...new Set(batch.items.map(i => i.account))]) {
    const acct = accounts.find(a => a.nickname === nick);
    if (!acct) continue;
    for (const r of await ynabGetAccountTransactions(env, acct.ynab_account_id, lookbackDate(env))) current.set(r.id, r);
  }
  const deletable: typeof batch.items = [];
  const kept: any[] = [];
  for (const item of batch.items) {
    const r = current.get(item.id);
    if (!r) { kept.push({ ...item, reason: "already gone (or older than the lookback window)" }); continue; }
    if (r.cleared === "reconciled") { kept.push({ ...item, reason: "reconciled" }); continue; }
    if (isWorkerImportPrefix(r.import_id) && /^(wpend|pl|pcc):/.test(r.import_id || "") && r.cleared !== "uncleared") {
      kept.push({ ...item, reason: "was pending, has since posted" }); continue;
    }
    deletable.push(item);
  }

  if (url.searchParams.get("confirm") !== "true") {
    return {
      ok: true,
      dry_run: true,
      target: { index: idx, ts: batch.ts, trigger: batch.trigger, count: batch.count },
      would_delete: deletable.slice(0, 100),
      would_keep: kept.slice(0, 100),
      message: `This would delete ${deletable.length} of ${batch.count} transaction(s) created by the "${batch.trigger}" sync at ${batch.ts}${kept.length ? ` (${kept.length} kept: settled, reconciled or gone)` : ""}.\n\nPosted rows removed here won't be re-imported: YNAB remembers their import ids, and the worker treats them as deleted on purpose. A pending row removed here comes back once the charge posts.`,
      reimport_note: "Posted rows removed by undo are not re-imported."
    };
  }

  let deleted = 0;
  const errors: any[] = [];
  for (const item of deletable) {
    try {
      await ynabDeleteTransaction(env, item.id);
      deleted++;
    } catch (e: any) {
      errors.push({ id: item.id, account: item.account, error: e.message });
    }
  }

  // Drop what was undone so it can't be applied twice. Rows YNAB wouldn't delete stay
  // in the entry, so the undo can be retried for them.
  const failedIds = new Set(errors.map(e => e.id));
  const leftover = batch.items.filter(i => failedIds.has(i.id));
  const fresh = await getUndoLog(env);
  const at = fresh.findIndex(b => b.ts === batch.ts);
  if (at >= 0) {
    if (leftover.length) fresh[at] = { ...fresh[at], items: leftover, count: leftover.length };
    else fresh.splice(at, 1);
    await env.SYNC_STATE.put(UNDO_LOG_KV_KEY, JSON.stringify(fresh));
  }

  return { ok: errors.length === 0, undone: true, target_ts: batch.ts, trigger: batch.trigger, requested: deletable.length, deleted, kept, errors };
}
