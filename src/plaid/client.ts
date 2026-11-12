import { Env } from "../types";
import { fetchWithRetry, readJsonBody } from "../util/http";

const PLAID_READ_ONLY_POST_PATHS = new Set([
  "/transactions/sync",
  "/transactions/get",
  "/accounts/get",
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
  }, 2, true); // Plaid POST endpoints are read/sync operations, not financial mutations.

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`Plaid ${path}: ${data.error_code || resp.status} - ${data.error_message || "unknown"}`);
  }

  return data;
}
