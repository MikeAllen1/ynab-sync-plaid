import { Env } from "../types";
import { CONFIG_UNREADABLE } from "../store/accounts";

/**
 * Names for transfers to and from your own accounts at other banks, by the last digits
 * the bank prints ("...1234", "XXXXXX1234", "Account 1234"). Stored in KV under
 * "transfer_labels" and edited on the dashboard (Rules -> Transfer labels):
 *   [{ "tail": "1234", "label": "Savings" },
 *    { "tail": "5678", "label": "Kids' allowance", "out": "Allowance", "in": "Allowance refund" }]
 * "out"/"in" override the payee for money leaving / arriving; otherwise the payee is
 * the label going out and "Transfer from <label>" coming in.
 */
export interface TransferLabel { tail: string; label: string; out?: string; in?: string }

export const TRANSFER_LABELS_KV_KEY = "transfer_labels";

export function normalizeTransferLabel(x: any): TransferLabel | null {
  const tail = String(x?.tail || "").replace(/\D/g, "").slice(-4);
  const label = String(x?.label || "").trim().slice(0, 80);
  if (tail.length < 3 || !label) return null;
  const out = String(x?.out || "").trim().slice(0, 80), inn = String(x?.in || "").trim().slice(0, 80);
  return { tail, label, ...(out ? { out } : {}), ...(inn ? { in: inn } : {}) };
}

export async function getTransferLabels(env: Env): Promise<TransferLabel[]> {
  let raw: string | null;
  try { raw = await env.SYNC_STATE.get(TRANSFER_LABELS_KV_KEY); }
  catch {
    throw new Error(`${CONFIG_UNREADABLE}: saved transfer labels could not be read from SYNC_STATE. Sync was stopped rather than guessing transfer payees.`);
  }
  if (raw === null) return [];
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new Error(`${CONFIG_UNREADABLE}: saved transfer labels contain invalid JSON. Repair them in Settings before syncing.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${CONFIG_UNREADABLE}: saved transfer labels are not an array. Repair them in Settings before syncing.`);
  }
  const normalized = parsed.map(normalizeTransferLabel);
  if (normalized.some(label => !label)) {
    throw new Error(`${CONFIG_UNREADABLE}: saved transfer labels contain an invalid entry. Repair them in Settings before syncing.`);
  }
  return normalized as TransferLabel[];
}

export async function putTransferLabels(env: Env, labels: unknown): Promise<TransferLabel[]> {
  const list = (Array.isArray(labels) ? labels : []).map(normalizeTransferLabel).filter((x): x is TransferLabel => !!x).slice(0, 50);
  await env.SYNC_STATE.put(TRANSFER_LABELS_KV_KEY, JSON.stringify(list));
  return list;
}
