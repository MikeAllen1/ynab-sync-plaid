import { Env } from "../types";
import { json } from "./http";

// Optimistic concurrency for the dashboard's list editors (accounts, skip rules,
// payee aliases, transfer labels). Each is saved as a whole list, so a page that
// loaded before a change made elsewhere (another tab, the phone, the setup page)
// would otherwise overwrite that change without anyone noticing: re-enable an
// account someone turned off, or drop an account that was just added.
//
// GET returns a version of what is stored; a save that sends expected_version is
// refused when the stored value has changed since. Saves without expected_version
// (scripts, curl) keep the old last-write-wins behavior.

export async function contentVersion(...parts: (string | null)[]): Promise<string> {
  const text = parts.map(p => (p === null ? "\u0000" : p)).join("\u0001");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function storedVersion(env: Env, ...keys: string[]): Promise<string> {
  const values: (string | null)[] = [];
  for (const key of keys) values.push(await env.SYNC_STATE.get(key));
  return contentVersion(...values);
}

/** null when the save may go ahead; a 409 response when the page is out of date. */
export async function staleCheck(env: Env, expected: unknown, what: string, ...keys: string[]): Promise<Response | null> {
  if (expected === undefined || expected === null) return null;
  if (String(expected) === (await storedVersion(env, ...keys))) return null;
  return json({
    ok: false,
    stale: true,
    error: `Your ${what} were changed somewhere else (another tab or device) after this page loaded. Nothing was saved. Reload them, then make your change again.`
  }, 409);
}
