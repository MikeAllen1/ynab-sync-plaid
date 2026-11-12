import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";

function makeLock() {
  const values = new Map<string, unknown>();
  let transactionTail = Promise.resolve();
  const transaction = async (fn: (txn: any) => Promise<any>) => {
    let release!: () => void;
    const previous = transactionTail;
    transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await fn({
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async ({ prefix = "" }: any = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
      });
    } finally { release(); }
  };
  const storage: any = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix = "" }: any = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction,
  };
  return new SyncLock({ storage } as any);
}

test("Durable Object webhook receipt claim is atomic and rejects duplicate bodies", async () => {
  const lock = makeLock();
  const makeRequest = () => new Request("https://sync-lock/webhook/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest: "a".repeat(64), ttl_seconds: 600 }),
  });
  const [first, second] = await Promise.all([lock.fetch(makeRequest()), lock.fetch(makeRequest())]);
  const results = await Promise.all([first.json() as Promise<any>, second.json() as Promise<any>]);
  assert.equal(results.filter(r => r.claimed).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 1);
});

test("Durable Object webhook receipt claim rejects malformed digests", async () => {
  const lock = makeLock();
  const response = await lock.fetch(new Request("https://sync-lock/webhook/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest: "not-a-digest" }),
  }));
  assert.equal(response.status, 400);
});

test("Durable Object releases a webhook receipt after downstream persistence fails", async () => {
  const lock = makeLock();
  const digest = "b".repeat(64);
  const claim = () => lock.fetch(new Request("https://sync-lock/webhook/claim", {
    method: "POST", body: JSON.stringify({ digest, ttl_seconds: 600 }),
  }));
  assert.equal((await claim()).status, 200);
  const release = await lock.fetch(new Request("https://sync-lock/webhook/release", {
    method: "POST", body: JSON.stringify({ digest }),
  }));
  assert.equal(release.status, 200);
  const retry = await claim().then(r => r.json() as Promise<any>);
  assert.equal(retry.claimed, true);
});
