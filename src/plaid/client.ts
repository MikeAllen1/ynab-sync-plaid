import { Env } from "../types";
import { fetchWithRetry, readJsonBody } from "../util/http";

export async function plaidCall(env: Env, path: string, body: any): Promise<any> {
  const resp = await fetchWithRetry(`https://${env.PLAID_ENV}.plaid.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body
    })
  });

  const data: any = await readJsonBody(resp);

  if (!resp.ok) {
    throw new Error(`Plaid ${path}: ${data.error_code || resp.status} - ${data.error_message || "unknown"}`);
  }

  return data;
}
