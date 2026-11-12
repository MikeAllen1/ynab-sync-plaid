import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccounts, putAccounts, resealAccountTokens, saveAccountConfiguration, tokenStorageMode } from "../src/store/accounts";
import { openToken, sealToken } from "../src/util/token-crypto";
import type { Env } from "../src/types";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

function makeEnv(extra: Partial<Env>, initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const env = { ...extra, SYNC_STATE: {
    get: async (k: string) => values.get(k) ?? null,
    put: async (k: string, v: string) => { values.set(k, v); },
    delete: async (k: string) => { values.delete(k); }
  } } as unknown as Env;
  return { env, values };
}
const account = { nickname: "checking", plaid_access_token: "access-production-secret", plaid_account_id: "p1", ynab_account_id: "y1" };

test("with a key, saved tokens are ciphertext in KV and plaintext to the worker", async () => {
  const { env, values } = makeEnv({ TOKEN_ENCRYPTION_KEY: KEY_A });
  await saveAccountConfiguration(env, [account], [{ nickname: "checking", sync_enabled: false }]);
  const raw = values.get("account_config_bundle") || "";
  assert.equal(raw.includes("access-production-secret"), false, "the token must not be readable from KV");
  assert.match(raw, /enc:v1:/);
  assert.equal((await getAccounts(env))[0].plaid_access_token, "access-production-secret");
  assert.equal(await tokenStorageMode(env), "encrypted");
});

test("existing plaintext tokens keep working and are encrypted by a re-seal", async () => {
  const { env, values } = makeEnv({ TOKEN_ENCRYPTION_KEY: KEY_A }, { account_map: JSON.stringify([account]) });
  assert.equal((await getAccounts(env))[0].plaid_access_token, "access-production-secret");
  assert.equal(await tokenStorageMode(env), "plaintext");
  await resealAccountTokens(env);
  assert.equal((values.get("account_map") || "").includes("access-production-secret"), false);
  assert.equal((await getAccounts(env))[0].plaid_access_token, "access-production-secret");
});

test("key rotation: the previous key still reads, and a re-seal moves to the new key", async () => {
  const { env: oldEnv, values } = makeEnv({ TOKEN_ENCRYPTION_KEY: KEY_A });
  await putAccounts(oldEnv, [account]);
  const rotated = { ...oldEnv, TOKEN_ENCRYPTION_KEY: KEY_B, TOKEN_ENCRYPTION_KEY_PREVIOUS: KEY_A } as Env;
  assert.equal((await getAccounts(rotated))[0].plaid_access_token, "access-production-secret");
  await resealAccountTokens(rotated);
  const newOnly = { ...oldEnv, TOKEN_ENCRYPTION_KEY: KEY_B } as Env;
  assert.equal((await getAccounts(newOnly))[0].plaid_access_token, "access-production-secret");
  assert.ok(values.get("account_map"));
});

test("encrypted tokens without the key fail closed with a clear message", async () => {
  const { env } = makeEnv({ TOKEN_ENCRYPTION_KEY: KEY_A });
  const sealed = await sealToken(env, "access-x");
  await assert.rejects(openToken({} as Env, sealed), /TOKEN_ENCRYPTION_KEY is not set/);
  await assert.rejects(openToken({ TOKEN_ENCRYPTION_KEY: KEY_B } as Env, sealed), /can't be decrypted/);
});

test("without a key nothing changes: tokens are stored as before", async () => {
  const { env, values } = makeEnv({});
  await putAccounts(env, [account]);
  assert.match(values.get("account_map") || "", /access-production-secret/);
});
