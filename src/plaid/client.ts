import { Env } from "../types";
import { fetchWithRetry, readJsonBody } from "../util/http";

const PLAID_READ_ONLY_POST_PATHS = new Set([
  "/transactions/sync",
  "/transactions/get",
  "/accounts/get",
  "/accounts/balance/get",
  "/item/get",
  "/webhook_verification_key/get"
]);

export async function plaidCall(env: Env, path: string, body: any): Promise<any> {
  // Plaid uses POST for both reads and actions. Only known read-only endpoints may
  // be replayed; /transactions/refresh and webhook/configuration mutations must not.
  const retrySafe = PLAID_READ_ONLY_POST_PATHS.has(path);
  const resp = await fetchWithRetry(`https://${env.PLAID_ENV}.plaid.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body
    })
  }, 2, { retrySafe, env });

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    const detail = {
      provider: "plaid", status: resp.status,
      error_type: data?.error_type || null,
      error_code: data?.error_code || null,
      request_id: data?.request_id || null,
      message: data?.error_message || data?.non_json_response || "unknown"
    };
    throw new Error(`Plaid ${path} failed: ${JSON.stringify(detail)}`);
  }

  // A 2xx response with an invalid envelope is not an empty successful result.
  // Validate the critical fields used to advance cursors or reconcile records.
  const invalid = (reason: string): never => {
    throw new Error(`Plaid ${path} returned an invalid response: ${reason}`);
  };
  if (path === "/transactions/sync") {
    for (const field of ["added", "modified", "removed"]) {
      if (!Array.isArray(data?.[field])) invalid(`${field} must be an array`);
    }
    if (typeof data?.has_more !== "boolean") invalid("has_more must be boolean");
    if (typeof data?.next_cursor !== "string") invalid("next_cursor must be a string");
    for (const t of [...data.added, ...data.modified]) {
      if (!t || typeof t.transaction_id !== "string" || !t.transaction_id ||
          typeof t.account_id !== "string" || !t.account_id ||
          typeof t.amount !== "number" || !Number.isFinite(t.amount) ||
          typeof t.date !== "string" || typeof t.pending !== "boolean") {
        invalid("transaction update is missing required identity, amount, date, or pending fields");
      }
    }
    for (const t of data.removed) {
      if (!t || typeof t.transaction_id !== "string" || !t.transaction_id ||
          typeof t.account_id !== "string" || !t.account_id) {
        invalid("removed transaction is missing transaction_id or account_id");
      }
    }
  } else if (path === "/transactions/get") {
    if (!Array.isArray(data?.transactions)) invalid("transactions must be an array");
    if (!Number.isInteger(data?.total_transactions) || data.total_transactions < 0) invalid("total_transactions must be a nonnegative integer");
  } else if (path === "/accounts/get") {
    if (!Array.isArray(data?.accounts)) invalid("accounts must be an array");
  } else if (path === "/item/get") {
    if (!data?.item || typeof data.item !== "object") invalid("item must be an object");
  }

  return data;
}
