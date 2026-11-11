import { Env } from "../types";

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
  try {
    const raw = await env.SYNC_STATE.get(TRANSFER_LABELS_KV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeTransferLabel).filter((x): x is TransferLabel => !!x) : [];
  } catch { return []; }
}

export async function putTransferLabels(env: Env, labels: unknown): Promise<TransferLabel[]> {
  const list = (Array.isArray(labels) ? labels : []).map(normalizeTransferLabel).filter((x): x is TransferLabel => !!x).slice(0, 50);
  await env.SYNC_STATE.put(TRANSFER_LABELS_KV_KEY, JSON.stringify(list));
  return list;
}
