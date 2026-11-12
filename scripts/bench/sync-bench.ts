/**
 * Performance baseline for the sync, against the simulated world in test/sim/world.ts.
 *
 *   npx tsx scripts/bench/sync-bench.ts [1000,10000,50000,100000]
 *
 * For each size N (Plaid transactions in the bank feed), measures:
 *   A. bootstrap of an account whose feed already holds N transactions,
 *   B. a backlog: N new charges arriving in one cursor delta (a bank replaying history
 *      after a reconnect, or a newly linked account), dated over the last ~100 days,
 *   C. the next ordinary cron run (5 new charges per account) after that backlog.
 * Reported per run: outbound subrequests (Free plan: 50 per invocation), YNAB requests
 * (the worker's own budget: 180 per rolling hour), KV reads/writes (Free plan: 100,000
 * reads and 1,000 writes a day), Durable Object calls, Worker JS time (wall time minus
 * time inside the simulators; Cloudflare's Free plan allows 10 ms of CPU), largest
 * stored value, and rows created in YNAB.
 */
import { makeWorld } from "../../test/sim/world";
import { syncAll } from "../../src/sync/run";
import { withDurableAccountState } from "../../src/store/durable-state";
import { resetRunCache } from "../../src/plaid/fetch";

const sizes = (process.argv[2] || "1000,10000,50000,100000").split(",").map(Number);
const day = (base: string, d: number) => { const t = new Date(base + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };

async function measure(w: ReturnType<typeof makeWorld>, env: any, label: string, n: number) {
  w.resetCounters(); resetRunCache();
  const heap0 = process.memoryUsage().heapUsed;
  const t = performance.now();
  let result: any, error: string | undefined;
  try { result = await syncAll(env, { trigger: "manual" }); } catch (e: any) { error = String(e?.message || e).slice(0, 200); }
  const wall = performance.now() - t;
  const c = w.counters;
  const statuses = (result?.results || []).map((r: any) => r.status + (r.error ? ": " + String(r.friendly_error || r.error).slice(0, 120) : ""));
  const row = {
    n, run: label, wall_ms: Math.round(wall), worker_js_ms: Math.round(wall - c.fakeMs), external: c.external, plaid: c.plaid, ynab: c.ynab, ynab_writes: c.ynabWrites,
    kv_reads: c.kvGet, kv_writes: c.kvPut + c.kvDelete, do_calls: c.doCalls, largest_kv_value_kb: Math.round(w.maxValue.bytes / 1024), largest_kv_key: w.maxValue.key.split(":")[0],
    heap_growth_mb: Math.round((process.memoryUsage().heapUsed - heap0) / 1048576), ynab_rows: w.activeYnabRows().length, statuses: [...new Set(statuses)], error,
  };
  process.stderr.write(JSON.stringify(row) + "\n");
  return row;
}

async function main() {
  const out: any[] = [];
  for (const n of sizes) {
    // A: N transactions of history spread over 3 accounts (one bank login).
    const w = makeWorld({ accounts: 3, history: Math.round(n / 3) });
    const restore = w.install();
    const env = withDurableAccountState(w.env);
    out.push(await measure(w, env, "A bootstrap", n));
    // B: N new charges in one delta, over the last 100 days.
    for (let i = 0; i < n; i++) { const a = w.accounts[i % 3]; w.changeLog.push({ kind: "added", t: w.addPlaid(a, day(w.today, i % 100), 1 + (i % 500) / 7, `Backlog ${i % 300}`) }); }
    out.push(await measure(w, env, "B backlog", n));
    // B2: the run after (anything left over).
    out.push(await measure(w, env, "B2 next run", n));
    // C: ordinary activity.
    w.newActivity(5);
    out.push(await measure(w, env, "C ordinary", n));
    restore();
  }
  console.log(JSON.stringify(out, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
