import { Env } from "../types";

// ---------- Plaid access tokens, encrypted at rest ----------
//
// Plaid access tokens are bearer credentials for your bank data. KV is encrypted by
// Cloudflare at rest, but anyone who can read the namespace (a Cloudflare API token
// with KV read, or a logged-in wrangler) can read its values. With the
// TOKEN_ENCRYPTION_KEY secret set, tokens are stored as AES-256-GCM ciphertext, so
// reading KV alone no longer yields a usable token: the key lives only in the
// Worker's encrypted secrets.
//
//   TOKEN_ENCRYPTION_KEY           32 random bytes, base64 (openssl rand -base64 32)
//   TOKEN_ENCRYPTION_KEY_PREVIOUS  optional, during a key rotation: still accepted
//                                  for reading; everything is re-sealed with the
//                                  current key on the next save.
//
// Without a key, tokens are stored as before (plaintext) so existing setups keep
// working; the dashboard health report says which mode is in effect.

export const SEALED_TOKEN_PREFIX = "enc:v1:";
const AAD = new TextEncoder().encode("ynab-sync:plaid_access_token:v1");

const keyCache = new Map<string, Promise<CryptoKey>>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function importKey(material: string): Promise<CryptoKey> {
  let cached = keyCache.get(material);
  if (!cached) {
    cached = (async () => {
      let raw: Uint8Array;
      try { raw = b64ToBytes(material.trim()); } catch { throw new Error("TOKEN_ENCRYPTION_KEY must be base64 (openssl rand -base64 32)."); }
      if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32).");
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    keyCache.set(material, cached);
  }
  return cached;
}

export function tokenEncryptionConfigured(env: Env): boolean {
  return !!env.TOKEN_ENCRYPTION_KEY;
}

/** Production workers don't store NEW bank tokens unencrypted unless explicitly allowed. */
export function plaintextTokensRefused(env: Env): boolean {
  return String(env.PLAID_ENV || "").toLowerCase() === "production" && !env.TOKEN_ENCRYPTION_KEY &&
    String(env.ALLOW_PLAINTEXT_TOKENS || "").toLowerCase() !== "true";
}

export function isSealedToken(value: string | undefined | null): boolean {
  return String(value || "").startsWith(SEALED_TOKEN_PREFIX);
}

/** Encrypt a token for storage. Without a key (or if already sealed) it is returned unchanged. */
export async function sealToken(env: Env, token: string): Promise<string> {
  if (!token || isSealedToken(token) || !env.TOKEN_ENCRYPTION_KEY) return token;
  const key = await importKey(env.TOKEN_ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, new TextEncoder().encode(token)));
  return `${SEALED_TOKEN_PREFIX}${bytesToB64(iv)}:${bytesToB64(ct)}`;
}

/** Decrypt a stored token. Plaintext (legacy) values pass through unchanged. */
export async function openToken(env: Env, stored: string): Promise<string> {
  if (!isSealedToken(stored)) return stored;
  const [ivB64, ctB64] = stored.slice(SEALED_TOKEN_PREFIX.length).split(":");
  const candidates = [env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS].filter(Boolean) as string[];
  if (candidates.length === 0) {
    throw new Error("CONFIG_UNREADABLE: bank tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set. Restore the secret (npx wrangler secret put TOKEN_ENCRYPTION_KEY). Nothing was synced.");
  }
  for (const material of candidates) {
    try {
      const key = await importKey(material);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64), additionalData: AAD }, key, b64ToBytes(ctB64));
      return new TextDecoder().decode(pt);
    } catch { /* try the next key */ }
  }
  throw new Error("CONFIG_UNREADABLE: a stored bank token can't be decrypted with TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY_PREVIOUS). Restore the key that sealed it. Nothing was synced.");
}

export async function sealAccountTokens<T extends { plaid_access_token: string }>(env: Env, accounts: T[]): Promise<T[]> {
  return Promise.all(accounts.map(async a => ({ ...a, plaid_access_token: await sealToken(env, a.plaid_access_token) })));
}

export async function openAccountTokens<T extends { plaid_access_token: string }>(env: Env, accounts: T[]): Promise<T[]> {
  return Promise.all(accounts.map(async a => ({ ...a, plaid_access_token: await openToken(env, a.plaid_access_token) })));
}
