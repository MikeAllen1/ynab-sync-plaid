import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeSendHealthAlert } from "../src/sync/run";
import type { Env } from "../src/types";

function makeEnv(extra: Record<string, string>, initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const env = {
    ...extra,
    SYNC_STATE: {
      get: async (k: string) => values.get(k) ?? null,
      put: async (k: string, v: string) => { values.set(k, v); },
      delete: async (k: string) => { values.delete(k); }
    }
  } as unknown as Env;
  return { env, values };
}

const failure = [{ account: "checking", status: "error", error: "boom", friendly_error: "Boom" }];

test("a failing sync alerts both email and the webhook when both are configured", async () => {
  const { env } = makeEnv({ RESEND_API_KEY: "k", ALERT_EMAIL_TO: "me@example.com", ALERT_WEBHOOK_URL: "https://hooks.example/x" });
  const original = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (input: any) => { hosts.push(new URL(String(input)).hostname); return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    await maybeSendHealthAlert(env, { trigger: "cron" }, failure);
    assert.deepEqual(hosts.sort(), ["api.resend.com", "hooks.example"]);
    hosts.length = 0;
    await maybeSendHealthAlert(env, { trigger: "cron" }, failure);
    assert.deepEqual(hosts, [], "the same state is not re-sent on either channel");
  } finally { globalThis.fetch = original; }
});

test("a failed webhook delivery is retried without re-sending the email", async () => {
  const { env } = makeEnv({ RESEND_API_KEY: "k", ALERT_EMAIL_TO: "me@example.com", ALERT_WEBHOOK_URL: "https://hooks.example/x" });
  const original = globalThis.fetch;
  const hosts: string[] = [];
  let webhookUp = false;
  globalThis.fetch = (async (input: any) => {
    const host = new URL(String(input)).hostname; hosts.push(host);
    return new Response("{}", { status: host === "hooks.example" && !webhookUp ? 500 : 200 });
  }) as typeof fetch;
  try {
    await maybeSendHealthAlert(env, { trigger: "cron" }, failure);
    hosts.length = 0; webhookUp = true;
    await maybeSendHealthAlert(env, { trigger: "cron" }, failure);
    assert.deepEqual(hosts, ["hooks.example"]);
  } finally { globalThis.fetch = original; }
});

test("email-only setups keep their existing alert state (no alert on upgrade)", async () => {
  const { env } = makeEnv({ RESEND_API_KEY: "k", ALERT_EMAIL_TO: "me@example.com" }, { last_alert_state: "error:checking" });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  try {
    await maybeSendHealthAlert(env, { trigger: "cron" }, failure);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
