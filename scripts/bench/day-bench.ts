/**
 * One simulated day of cron runs (96, every 15 minutes) against test/sim/world.ts, with new
 * bank activity through the day. Reports daily totals against Cloudflare's Free plan
 * (KV: 100,000 reads, 1,000 writes, 1,000 lists a day) and per-run peaks (subrequests, YNAB
 * requests per hour against the worker's 180/hour budget).
 *
 *   npx tsx scripts/bench/day-bench.ts [accounts] [frequencyMinutes]
 */
import { mock } from "node:test";
import { makeWorld, runCron } from "../../test/sim/world";
import worker from "../../src/index";

const accounts = Number(process.argv[2] || 6), freq = Number(process.argv[3] || 60);
async function main() {
  const start = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  const w = makeWorld({ accounts, history: 60, today: new Date(start).toISOString().slice(0, 10) });
  w.kvData.set("account_automation_settings", JSON.stringify(w.accounts.map(a => ({ nickname: a.nickname, sync_enabled: true, backfill_enabled: false, sync_frequency_minutes: freq, audit_enabled: true }))));
  w.limits.subrequests = Number(process.env.SUBREQUEST_LIMIT || 0);
  const restore = w.install();
  const totals = { kvGet: 0, kvPut: 0, kvDelete: 0, kvList: 0, doCalls: 0, plaid: 0, ynab: 0, external: 0 };
  let capErrors = 0, peakExternal = 0, peakYnabHour = 0, ynabHour = 0, maxJs = 0, sumJs = 0;
  const byKey = new Map<string, number>();
  const realPut = (w.env.SYNC_STATE as any).put.bind(w.env.SYNC_STATE);
  (w.env.SYNC_STATE as any).put = async (k: string, v: string, o?: any) => { const base = k.split(":")[0]; byKey.set(base, (byKey.get(base) || 0) + 1); return realPut(k, v, o); };
  for (let i = 0; i < 96; i++) {
    mock.timers.setTime(start + i * 15 * 60000);
    if (i % 8 === 4) w.newActivity(2);
    w.resetCounters();
    const r = await runCron(worker as any, w.env, 30000);
    const js = r.ms - w.counters.fakeMs;
    maxJs = Math.max(maxJs, js); sumJs += js;
    for (const k of Object.keys(totals)) (totals as any)[k] += (w.counters as any)[k];
    peakExternal = Math.max(peakExternal, w.counters.external);
    const err = w.kvData.get("last_error"); if (err && /Too many subrequests/.test(err)) capErrors++;
    if (i % 4 === 0) ynabHour = 0;
    ynabHour += w.counters.ynab; peakYnabHour = Math.max(peakYnabHour, ynabHour);
  }
  restore(); mock.timers.reset();
  const out = { accounts, frequency_minutes: freq, runs: 96, totals, kv_writes_per_day: totals.kvPut + totals.kvDelete, peak_subrequests_per_run: peakExternal,
    peak_ynab_requests_per_hour: peakYnabHour, worker_js_ms_avg: Math.round(sumJs / 96), worker_js_ms_max: Math.round(maxJs),
    kv_writes_by_key: Object.fromEntries([...byKey].sort((a, b) => b[1] - a[1])), ynab_rows: w.activeYnabRows().length,
    runs_with_subrequest_errors: capErrors, expected_rows: 24 * accounts, last_error: w.kvData.get("last_error")?.slice(0, 300) || null };
  console.log(JSON.stringify(out, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
