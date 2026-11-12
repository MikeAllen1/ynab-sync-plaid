import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncLock } from "../src/lock/sync-lock-do";

class MemoryStorage {
  values = new Map<string, any>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key); }
  async put(key: string, value: any): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async transaction<T>(fn: (txn: this) => Promise<T>): Promise<T> { return fn(this); }
}

test("YNAB rolling request budget is atomic and stops before the provider limit", async () => {
  const storage = new MemoryStorage();
  const lock = new SyncLock({ storage } as any);
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    for (let i = 0; i < 180; i++) {
      const response = await lock.fetch(new Request("https://sync-lock/ynab-rate/reserve", { method: "POST" }));
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).reserved, true);
    }
    const blocked = await lock.fetch(new Request("https://sync-lock/ynab-rate/reserve", { method: "POST" }));
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json() as any).reserved, false);
  } finally {
    Date.now = originalNow;
  }
});

test("YNAB rolling request budget releases timestamps after one hour", async () => {
  const storage = new MemoryStorage();
  const lock = new SyncLock({ storage } as any);
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 180; i++) {
      await lock.fetch(new Request("https://sync-lock/ynab-rate/reserve", { method: "POST" }));
    }
    now += 60 * 60 * 1000 + 1;
    const next = await lock.fetch(new Request("https://sync-lock/ynab-rate/reserve", { method: "POST" }));
    assert.equal(next.status, 200);
  } finally {
    Date.now = originalNow;
  }
});
