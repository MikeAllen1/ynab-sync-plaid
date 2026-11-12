/**
 * Failure-mode matrix: each test drives the whole Worker (cron entry point, lock, KV,
 * Durable Object state, Plaid, YNAB) through one failure using the simulated world in
 * test/sim/world.ts, then checks what the user sees during the failure and that the next
 * run recovers without duplicate rows.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, runCron } from "./sim/world";
import worker from "../src/index";
import { syncAll } from "../src/sync/run";
import { withDurableAccountState } from "../src/store/durable-state";
import { resetRunCache } from "../src/plaid/fetch";
import { acquireSyncLock, activeLeases, dropLease, holdLease } from "../src/lock/lock";
import { timeouts } from "../src/util/http";

type World = ReturnType<typeof makeWorld>;

/** A world whose accounts are already set up, with `per` new charges waiting per account. */
async function readyWorld(opts: { accounts?: number; per?: number } = {}) {
  const w = makeWorld({ accounts: opts.accounts ?? 3, history: 20 });
  const restore = w.install();
  const env = withDurableAccountState(w.env);
  resetRunCache();
  await syncAll(env, { trigger: "manual" });   // sets every account up
  w.newActivity(opts.per ?? 3);
  w.resetCounters();
  return { w, env, restore };
}
const duplicates = (w: World) => {
  const ids = w.activeYnabRows().filter(r => r.import_id).map(r => r.account_id + "|" + r.import_id);
  return ids.length - new Set(ids).size;
};
const lastError = (w: World) => w.kvData.get("last_error") || "";
async function manual(env: any) { resetRunCache(); return syncAll(env, { trigger: "manual" }); }
/** A manual sync that must finish within `ms` (a hung run fails the test instead of the suite). */
async function manualWithin(env: any, ms: number) {
  resetRunCache();
  const t = setTimeout(() => {}, 0);
  clearTimeout(t);
  return Promise.race([syncAll(env, { trigger: "manual" }), new Promise<"hung">(r => setTimeout(() => r("hung"), ms))]);
}

test("Plaid hangs: the request times out, the run finishes and releases the lock, and the next run imports everything", async () => {
  const saved = timeouts.requestMs;
  timeouts.requestMs = 200;
  const { w, env, restore } = await readyWorld();
  try {
    const before = w.activeYnabRows().length;
    w.modes.plaid = "hang"; w.modes.plaidPath = "/transactions/sync";
    const r = await manualWithin(env, 15_000);
    assert.notEqual(r, "hung", "the run must not wait forever on a hung provider");
    assert.ok(w.counters.abortedRequests > 0, "the hung request was abandoned by its deadline");
    assert.match(lastError(w), /timed out/);
    w.modes.plaid = "ok"; w.modes.plaidPath = "";
    const next = await manual(env);
    assert.notEqual(next.status, "skipped_locked", "the timed-out run must have released the lock");
    assert.equal(w.activeYnabRows().length - before, 9);
    assert.equal(duplicates(w), 0);
  } finally { timeouts.requestMs = saved; restore(); }
});

test("YNAB hangs on a write: the run gives up by its deadline and the next run adds each charge exactly once", async () => {
  const saved = timeouts.requestMs;
  timeouts.requestMs = 200;
  const { w, env, restore } = await readyWorld();
  try {
    const before = w.activeYnabRows().length;
    w.modes.ynab = "hang";
    const r = await manualWithin(env, 15_000);
    assert.notEqual(r, "hung");
    assert.ok(w.counters.abortedRequests > 0);
    assert.ok(w.counters.abortedRequests <= 2, "after two timeouts YNAB is skipped for the rest of the run");
    w.modes.ynab = "ok";
    await manual(env);
    assert.equal(w.activeYnabRows().length - before, 9);
    assert.equal(duplicates(w), 0);
  } finally { timeouts.requestMs = saved; restore(); }
});

test("an operation abandoned mid-run (invocation cancelled) does not make later runs abort", async () => {
  const { w, env, restore } = await readyWorld();
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  // A dashboard sync whose tab was closed: it took the lock, then its invocation was
  // cancelled, so its `finally` (dropLease/release) never ran.
  const abandonedEnv = withDurableAccountState({ ...w.env } as any);
  const abandoned = await acquireSyncLock(abandonedEnv);
  assert.ok(abandoned);
  holdLease(abandonedEnv, abandoned!);
  try {
    mock.timers.setTime(start + 16 * 60_000);   // its lock expires; the next cron takes over
    const before = w.activeYnabRows().length;
    const r = await manual(env);
    assert.deepEqual(r.results.map((x: any) => x.status), ["ok", "ok", "ok"], JSON.stringify(r.results.map((x: any) => x.error)));
    assert.equal(w.activeYnabRows().length - before, 9);
  } finally { dropLease(abandoned!); mock.timers.reset(); restore(); }
  assert.equal(activeLeases.has(abandoned!.id), false);
});

test("the abandoned operation itself still stops: its own lease renewal fails once another run owns the lock", async () => {
  const { w, restore } = await readyWorld();
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  const staleEnv = withDurableAccountState({ ...w.env } as any);
  const stale = (await acquireSyncLock(staleEnv))!;
  holdLease(staleEnv, stale);
  try {
    mock.timers.setTime(start + 16 * 60_000);
    const fresh = await acquireSyncLock(withDurableAccountState({ ...w.env } as any));
    assert.ok(fresh, "the expired lock can be taken over");
    resetRunCache();
    const { plaidCall } = await import("../src/plaid/client");
    await assert.rejects(plaidCall(staleEnv, "/accounts/get", { access_token: "access-0" }), /no longer owned/);
  } finally { dropLease(stale); mock.timers.reset(); restore(); }
});

test("Free plan subrequest limit: nine accounts every 15 minutes stay inside 50 requests and every charge arrives", async () => {
  const { w, env, restore } = await readyWorld({ accounts: 9, per: 2 });
  w.limits.subrequests = 50;   // Cloudflare fails the 51st outbound request
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const before = w.activeYnabRows().length;
    for (let i = 1; i <= 3; i++) {
      mock.timers.setTime(start + i * 16 * 60_000);
      w.resetCounters();
      await runCron(worker as any, w.env, 20_000);
      assert.doesNotMatch(lastError(w), /Too many subrequests/);
      assert.ok(w.counters.external <= 50, `run ${i} used ${w.counters.external} requests`);
    }
    assert.equal(w.activeYnabRows().length - before, 18);
    assert.equal(duplicates(w), 0);
  } finally { mock.timers.reset(); restore(); }
  void env;
});

test("accounts on one bank login share each Plaid feed page instead of reading it once per account", async () => {
  const { w, env, restore } = await readyWorld({ accounts: 3 });
  try {
    await manual(env);
    const syncCalls = [...w.byPath].filter(([k]) => k.endsWith("/transactions/sync")).reduce((n, [, v]) => n + v, 0);
    assert.equal(syncCalls, 1, "three accounts at one bank: one feed page read");
  } finally { restore(); }
});

for (const mode of ["429", "500", "network"] as const) {
  test(`Plaid answers ${mode}: nothing is written, the error is shown, the cursor stays put, and the next run catches up once`, async () => {
    const { w, env, restore } = await readyWorld();
    try {
      const before = w.activeYnabRows().length;
      w.modes.plaid = mode;
      const r = await manual(env);
      assert.equal(r.status, "completed_with_errors");
      assert.equal(w.activeYnabRows().length, before);
      assert.ok(lastError(w).length > 0);
      w.modes.plaid = "ok";
      await manual(env);
      assert.equal(w.activeYnabRows().length - before, 9);
      assert.equal(duplicates(w), 0);
    } finally { restore(); }
  });
}

test("a bank connection becomes invalid: the bank is marked as needing reconnection and other banks keep syncing", async () => {
  const { w, env, restore } = await readyWorld({ accounts: 6 });
  try {
    const before = w.activeYnabRows().length;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(input).includes("plaid.com") && body.access_token === "access-0")
        return Response.json({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" }, { status: 400 });
      return real(input, init);
    }) as typeof fetch;
    try {
      await manual(env);
      resetRunCache();
      const { runItemHealthCheck } = await import("../src/health/items");
      await runItemHealthCheck(env, true as any).catch(() => {});
    } finally { globalThis.fetch = real; }
    assert.match(w.kvData.get("item_health") || "", /needs_reauth/);
    assert.equal(w.activeYnabRows().length - before, 9, "the healthy bank's three accounts still synced");
  } finally { restore(); }
});

test("the lock store (Durable Object) is unavailable: nothing is written and the outage is recorded", async () => {
  const { w, env, restore } = await readyWorld();
  try {
    const before = w.activeYnabRows().length;
    w.modes.do = "down";
    const r = await runCron(worker as any, w.env, 10_000);
    assert.equal(r.settled, true);
    assert.equal(w.counters.ynabWrites, 0);
    assert.match(lastError(w), /SYNC_LOCK|Durable Object/);
    w.modes.do = "ok";
    await manual(env);
    assert.equal(w.activeYnabRows().length - before, 9);
  } finally { restore(); }
});

test("KV is unavailable: the run stops before reading the bank or writing YNAB", async () => {
  const { w, env, restore } = await readyWorld();
  try {
    w.modes.kv = "down";
    const r = await runCron(worker as any, w.env, 10_000);
    assert.equal(r.settled, true);
    assert.equal(w.counters.ynabWrites, 0);
    w.modes.kv = "ok";
    const before = w.activeYnabRows().length;
    await manual(env);
    assert.equal(w.activeYnabRows().length - before, 9);
    assert.equal(duplicates(w), 0);
  } finally { restore(); }
});

test("two cron runs overlap: one syncs, the other skips, and no charge is added twice", async () => {
  const { w, restore } = await readyWorld();
  try {
    const before = w.activeYnabRows().length;
    resetRunCache();
    const [a, b] = await Promise.all([
      syncAll(withDurableAccountState(w.env), { trigger: "manual" }),
      syncAll(withDurableAccountState({ ...w.env } as any), { trigger: "manual" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), ["completed", "skipped_locked"], JSON.stringify([a, b].map(x => x.results?.map((y: any) => y.error || y.status))));
    assert.equal(w.activeYnabRows().length - before, 9);
    assert.equal(duplicates(w), 0);
  } finally { restore(); }
});

test("the run is interrupted after YNAB saved the rows but before the sync state was saved: the next run doesn't duplicate them", async () => {
  const { w, env, restore } = await readyWorld();
  try {
    const before = w.activeYnabRows().length;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const r = await real(input, init);
      // The Durable Object goes away the moment YNAB has accepted the first batch.
      if (String(input).includes("api.ynab.com") && (init?.method || "GET") === "POST") w.modes.do = "down";
      return r;
    }) as typeof fetch;
    const start = Date.now();
    mock.timers.enable({ apis: ["Date"], now: start });
    try { await manual(env); } catch { /* the run may fail outright */ } finally { globalThis.fetch = real; }
    assert.ok(w.activeYnabRows().length > before, "YNAB has rows the worker never recorded");
    w.modes.do = "ok";
    // The failed run couldn't release its lock either: syncing waits for the lock to
    // expire (15 minutes), then resumes.
    assert.equal((await manual(env)).status, "skipped_locked");
    mock.timers.setTime(start + 16 * 60_000);
    await manual(env);
    mock.timers.reset();
    assert.equal(w.activeYnabRows().length - before, 9);
    assert.equal(duplicates(w), 0);
  } finally { restore(); }
});

test("a backlog of thousands of charges under the subrequest limit completes over a few runs without duplicates", async () => {
  const { w, env, restore } = await readyWorld({ per: 1500 });
  w.limits.subrequests = 50;
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const before = w.activeYnabRows().length;
    for (let i = 1; i <= 4 && w.activeYnabRows().length - before < 4500; i++) {
      mock.timers.setTime(start + i * 16 * 60_000);
      w.resetCounters();
      await runCron(worker as any, w.env, 60_000);
    }
    assert.equal(w.activeYnabRows().length - before, 4500);
    assert.equal(duplicates(w), 0);
  } finally { mock.timers.reset(); restore(); }
  void env;
});

test("a bank whose backlog is bigger than one run can read doesn't starve the other banks", async () => {
  const { w, restore } = await readyWorld({ accounts: 6, per: 0 });
  w.limits.subrequests = 50;
  // Bank 1 replays 30,000 charges (60 feed pages: more than one invocation can read).
  for (let i = 0; i < 30_000; i++) w.changeLog.push({ kind: "added", t: w.addPlaid(w.accounts[i % 3], w.today, 1 + (i % 400) / 3, `Replay ${i}`) });
  // Bank 2 has ordinary activity.
  for (const a of w.accounts.slice(3)) w.changeLog.push({ kind: "added", t: w.addPlaid(a, w.today, 12.34, "Coffee") });
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const bank2 = new Set(w.accounts.slice(3).map(a => a.ynab_account_id));
    const bank2Rows = () => w.activeYnabRows().filter(r => bank2.has(r.account_id) && r.amount === -12340).length;
    for (let i = 1; i <= 2; i++) {
      mock.timers.setTime(start + i * 16 * 60_000);
      w.resetCounters();
      await runCron(worker as any, w.env, 60_000);
    }
    // The first run may spend itself on the replaying bank; from then on that bank goes
    // last, so the healthy bank gets through.
    assert.equal(bank2Rows(), 3);
    assert.match(lastError(w), /acct-1/, "the stuck bank stays visible as an error");
  } finally { mock.timers.reset(); restore(); }
});
