import { NO_FRAMING } from "../util/http";
import { escapeHtml as esc, safeCssClass } from "../util/html";

export function dashboardHtml(): Response {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YNAB Sync</title>
  <style>
    :root {
      --bg: #f7f8fb; --surface: #fff; --subtle: #f9fafb; --muted-bg: #f3f4f6; --hover: #f1f5f9;
      --border: #e5e7eb; --border-strong: #cbd5e1; --control-border: #7b8494;
      --btn-primary: #2563eb;
      --text: #111827; --muted: #6b7280; --muted-strong: #374151;
      --primary: #2563eb; --primary-hover: #1d4ed8; --primary-soft: #eff6ff; --primary-text: #1e40af;
      --ok-bg: #ecfdf3; --ok: #166534; --ok-dot: #16a34a;
      --warn-bg: #fffbeb; --warn: #92400e; --warn-border: #fde68a; --warn-dot: #d97706;
      --bad-bg: #fef2f2; --bad: #991b1b; --bad-border: #fecaca; --bad-dot: #dc2626;
      --shadow: 0 1px 2px rgba(16,24,40,.05); --r-sm: 10px; --r-md: 14px; --r-lg: 18px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1020; --surface: #121a2b; --subtle: #0f1626; --muted-bg: #1b2438; --hover: #1b2438;
        --border: #243049; --border-strong: #33415e; --control-border: #6f7fa0;
        --btn-primary: #2563eb;
        --text: #e5e9f2; --muted: #93a0b8; --muted-strong: #c3cbdb;
        --primary: #3b82f6; --primary-hover: #2563eb; --primary-soft: #16223d; --primary-text: #9dc0ff;
        --ok-bg: #0f2a1c; --ok: #7ee2a8; --warn-bg: #2d2410; --warn: #f5c56b; --warn-border: #5a4718;
        --bad-bg: #2e1215; --bad: #ffa3a3; --bad-border: #5c2227;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
    .shell { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }
    a { color: var(--primary); }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 30px; letter-spacing: -.03em; }
    .sub { margin: 4px 0 0; color: var(--muted); }
    .pill, .chip { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; font-weight: 700; white-space: nowrap; background: var(--muted-bg); color: var(--muted-strong); }
    .pill { padding: 7px 14px; font-size: 13px; }
    .chip { padding: 3px 10px; font-size: 12px; }
    .pill::before, .chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .ok { background: var(--ok-bg); color: var(--ok); } .ok::before { background: var(--ok-dot); }
    .warn { background: var(--warn-bg); color: var(--warn); } .warn::before { background: var(--warn-dot); }
    .bad { background: var(--bad-bg); color: var(--bad); } .bad::before { background: var(--bad-dot); }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow); }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; overflow: hidden; }
    .kpi { padding: 18px 22px; } .kpi + .kpi { border-left: 1px solid var(--border); }
    .kpi-label { font-size: 12px; color: var(--muted); font-weight: 600; }
    .kpi-value { margin-top: 4px; font-size: 22px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .kpi-value.warn, .kpi-value.bad { background: none; } .kpi-value.warn::before, .kpi-value.bad::before { display: none; }
    .attention { border-radius: var(--r-md); padding: 12px 16px; margin-bottom: 20px; border-left: 3px solid var(--bad-dot); background: var(--bad-bg); color: var(--bad); }
    .attention.warn { border-left-color: var(--warn-dot); background: var(--warn-bg); color: var(--warn); }
    .attention.ok { border-left-color: var(--ok-dot); background: var(--ok-bg); color: var(--ok); }
    .attention ul { margin: 0; padding-left: 18px; }
    .rows { overflow: hidden; margin-bottom: 20px; }
    .row { display: grid; grid-template-columns: 1.3fr auto 1fr 1fr 1fr; gap: 14px; align-items: center; padding: 14px 22px; }
    .row + .row { border-top: 1px solid var(--border); }
    .row-name { font-weight: 700; font-size: 15px; }
    .metric { font-size: 12px; color: var(--muted); }
    .metric strong { display: block; color: var(--text); font-size: 14px; font-variant-numeric: tabular-nums; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; }
    .spacer { flex: 1; }
    .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 14px; border-radius: var(--r-sm); border: 1px solid var(--border); background: var(--surface); color: var(--muted-strong); font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; white-space: nowrap; }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--btn-primary); border-color: var(--btn-primary); color: #fff; } .btn.primary:hover { background: #1d4ed8; }
    .btn.live { box-shadow: inset 0 0 0 2px var(--warn-dot); }
    .btn.live::after { content: " (live)"; font-weight: 600; }
    .btn[aria-busy="true"] { opacity: .7; cursor: progress; }
    .flash { border-radius: var(--r-md); padding: 12px 16px; margin-bottom: 12px; border-left: 3px solid var(--ok-dot); background: var(--ok-bg); color: var(--ok); }
    .flash.warn { border-left-color: var(--warn-dot); background: var(--warn-bg); color: var(--warn); }
    .flash.bad { border-left-color: var(--bad-dot); background: var(--bad-bg); color: var(--bad); }
    .flash ul { margin: 0; padding-left: 18px; }
    .secondary { display: block; font-size: 11px; color: var(--muted); font-weight: 500; margin-top: 2px; }
    tr.needs td { background: var(--warn-bg); }
    details.adv summary { cursor: pointer; font-size: 12px; font-weight: 700; color: var(--muted); margin-top: 6px; }
    .btn.warning { background: var(--warn-bg); color: var(--warn); border-color: var(--warn-border); }
    .btn.danger { background: var(--bad-bg); color: var(--bad); border-color: var(--bad-border); }
    .btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
    .btn[disabled] { opacity: .5; cursor: default; }
    select, input[type=text], input[type=password], input:not([type]) { padding: 8px 10px; border: 1px solid var(--control-border); border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: inherit; width: 100%; }
    .toolbar select { width: auto; }
    label.inline { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--muted-strong); }
    .note { font-size: 12px; color: var(--muted); margin: 8px 4px 24px; }
    .note.live { color: var(--warn); font-weight: 600; }
    .tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
    .tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 10px 14px; font: inherit; font-weight: 650; color: var(--muted); cursor: pointer; white-space: nowrap; }
    .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
    .panel { display: none; } .panel.active { display: block; }
    .block { margin-bottom: 32px; }
    .block h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: -.02em; }
    .hint { margin: 0 0 14px; color: var(--muted); font-size: 13px; max-width: 72ch; }
    .list { display: grid; gap: 10px; }
    .item { padding: 14px 16px; }
    .item h3 { margin: 0 0 8px; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .kv { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); }
    .kv:first-of-type { border-top: 0; }
    .kv span:last-child { color: var(--text); font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
    .table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table th { text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .table td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .scroll { overflow-x: auto; }
    .empty { padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
    .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
    .grid2 > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .grid2 .full { grid-column: 1 / -1; }
    .field-label { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .recovery { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 0; border-top: 1px solid var(--border); }
    .recovery:first-child { border-top: 0; }
    .recovery p { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
    pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: var(--r-md); overflow: auto; max-height: 460px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .small { font-size: 12px; color: var(--muted); }
    .initially-hidden { display:none !important; } .is-busy { opacity:.5; } .mt-14 { margin-top:14px; } .no-margin { margin:0; }
    .m-6-0-12 { margin:6px 0 12px; } .m-8-0-14 { margin:8px 0 14px; }
    .p-10-14-0 { padding:10px 14px 0; } .p-0-14-10 { padding:0 14px 10px; }
    .money-neg { color: var(--bad); } .money-pos { color: var(--ok); }
    @media (max-width: 760px) {
      .shell { padding: 24px 16px 60px; }
      .kpis { grid-template-columns: repeat(2, 1fr); } .kpi:nth-child(3) { border-left: 0; } .kpi:nth-child(n+3) { border-top: 1px solid var(--border); }
      .row { grid-template-columns: 1fr auto; } .row .metric { grid-column: span 1; }
      .grid2 { grid-template-columns: 1fr; }
      .recovery { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
<main class="shell">
  <header class="head">
    <div>
      <h1>YNAB Sync</h1>
      <p class="sub">Plaid to YNAB: pending charges early, posted charges exactly once · version 1.0.0</p>
    </div>
    <div id="overall" class="pill" role="status">Checking…</div>
  </header>

  <div class="card kpis">
    <div class="kpi"><div class="kpi-label">Accounts healthy</div><div id="kpiHealthy" class="kpi-value">—</div><div id="kpiHealthyNote" class="small"></div></div>
    <div class="kpi"><div class="kpi-label">Unexplained difference</div><div id="kpiDiff" class="kpi-value">—</div><div id="kpiDiffNote" class="small"></div></div>
    <div class="kpi"><div class="kpi-label">Pending purchases at bank</div><div id="kpiPending" class="kpi-value">—</div><div id="kpiPendingAsOf" class="small"></div></div>
    <div class="kpi"><div class="kpi-label">Last successful sync</div><div id="kpiLast" class="kpi-value">—</div></div>
  </div>

  <div id="flash" class="flash initially-hidden" role="status" aria-live="polite"></div>
  <section id="attention" class="attention initially-hidden" role="status" aria-live="polite"></section>

  <div id="accountRows" class="card rows"><div class="row"><span class="row-name">Loading…</span></div></div>

  <div class="card toolbar">
    <button id="btnSync" class="btn primary writes" data-action="run-sync">Sync now</button>
    <button id="btnRecheck" class="btn" data-action="recheck" title="Read-only: re-reads the bank and YNAB balances and updates Account health">Re-check</button>
    <button id="btnRescan" class="btn writes" data-action="rescan" title="Look for bank transactions missing from YNAB, over the chosen number of days">Re-scan</button>
    <select id="rescanDays" aria-label="How far back Re-scan looks" title="How far back Re-scan looks"><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
    <a class="btn" href="https://app.ynab.com/" target="_blank" rel="noopener">Open YNAB ↗</a>
    <div class="spacer"></div>
    <label class="inline" title="Sync now, Re-scan, Re-check, Transaction reconcile and Activity act on this account">Account <select id="accountSelect"><option value="">All accounts</option></select></label>
    <label class="inline"><input type="checkbox" id="dryRun" checked /> Dry run</label>
  </div>
  <p id="dryNote" class="note"></p>

  <nav class="tabs" role="tablist" aria-label="Sections">
    <button class="tab active" role="tab" aria-selected="true" aria-controls="tab-activity" data-tab="activity">Activity</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="tab-health" data-tab="health">Account health</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="tab-reconcile" data-tab="reconcile">Transaction reconcile</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="tab-rules" data-tab="rules">Rules</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="tab-settings" data-tab="settings">Settings</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="tab-recovery" data-tab="recovery">Recovery</button>
  </nav>

  <section id="tab-activity" role="tabpanel" aria-label="activity" class="panel active">
    <div class="block initially-hidden" id="previewBlock">
      <h2>Dry-run preview</h2>
      <p class="hint">What a live run would do right now. Nothing below has been changed.</p>
      <div id="preview"></div>
    </div>
    <div class="block">
      <h2>Activity</h2>
      <p class="hint">Everything the worker changed in YNAB, newest first: imports, pending-to-posted flips, retired pending rows, skipped items.</p>
      <div id="events" class="card scroll"><div class="empty">Loading…</div></div>
    </div>
    <div class="block">
      <h2>Skipped by your rules</h2>
      <p class="hint">Bank items your skip rules told the worker not to import, such as income you enter in YNAB ahead of time.</p>
      <div id="skipped" class="card scroll"><div class="empty">Loading…</div></div>
    </div>
  </section>

  <section id="tab-health" role="tabpanel" aria-label="health" class="panel">
    <div class="block">
      <h2>Account health</h2>
      <p class="hint">Compares each YNAB balance with the bank's (posted balance adjusted for everything pending), after setting aside differences your skip rules expect, such as a front-loaded paycheck. Re-check runs a fresh audit.</p>
      <div id="audit" class="list"><div class="empty">Click Re-check.</div></div>
    </div>
  </section>

  <section id="tab-reconcile" role="tabpanel" aria-label="reconcile" class="panel">
    <div class="block">
      <h2>Transaction reconcile</h2>
      <p class="hint">Read-only, row by row. Each bank transaction is matched to one YNAB row using the same rules as the sync (identity first, then amount + date + payee, one-to-one). Anything left over is listed. Items the worker skips on purpose are listed separately.</p>
      <div class="actions"><label class="inline">Days <select id="reconDays"><option>7</option><option selected>14</option><option>21</option><option>30</option><option>60</option><option>90</option></select></label><button class="btn primary" data-action="run-reconcile">Run reconcile</button></div>
      <div id="recon" class="list mt-14"></div>
    </div>
  </section>

  <section id="tab-rules" role="tabpanel" aria-label="rules" class="panel">
    <div class="block">
      <h2>Skip rules</h2>
      <p class="hint">Bank items the worker should never import. There are none unless you add one: everything that affects a balance is imported. Delete takes effect immediately; edits and new rules need <strong>Save rules</strong>.</p>
      <div id="rules" class="list"></div>
      <div class="actions">
        <button class="btn" data-action="add-rule">+ Add rule</button>
        <button class="btn primary" data-action="save-rules">Save rules</button>
      </div>
    </div>
    <div class="block">
      <h2>Payee aliases</h2>
      <p class="hint">When the bank and YNAB name the same merchant differently (an old brand name vs the new one), group the names so they match.</p>
      <div id="aliases" class="list"></div>
      <div class="actions">
        <button class="btn" data-action="add-alias">+ Add group</button>
        <button class="btn primary" data-action="save-aliases">Save aliases</button>
      </div>
    </div>
    <div class="block">
      <h2>Transfer labels</h2>
      <p class="hint">Name transfers to and from your own accounts at other banks by the last digits the bank shows (&ldquo;&hellip;1234&rdquo;), so YNAB gets a stable payee it can learn a category for.</p>
      <div id="tlabels" class="list"></div>
      <div class="actions">
        <button class="btn" data-action="add-transfer-label">+ Add label</button>
        <button class="btn primary" data-action="save-transfer-labels">Save labels</button>
      </div>
    </div>
  </section>

  <section id="tab-settings" role="tabpanel" aria-label="settings" class="panel">
    <div class="block">
      <h2>Global sync</h2>
      <p class="hint">Master switch. While paused nothing is written and Plaid is not asked to refresh. Dry runs still work.</p>
      <div class="actions"><span id="globalState" class="chip">…</span><button id="globalBtn" class="btn warning" data-action="toggle-global">…</button></div>
    </div>
    <div class="block">
      <h2>Admin token</h2>
      <p class="hint">Stored only in this browser.</p>
      <div class="grid2"><div><input id="token" type="password" placeholder="Admin token" aria-label="Admin token" autocomplete="off" /></div><div class="actions no-margin"><button class="btn primary" data-action="save-token">Save</button><button class="btn ghost" data-action="clear-token">Clear</button></div></div>
    </div>
    <div class="block">
      <h2>Bank connections</h2>
      <p class="hint">Checked about every 6 hours. "Needs reauth" means the bank must be reconnected before its data goes stale.</p>
      <div id="items" class="list"></div>
      <div class="actions"><button class="btn" data-action="check-items">Check now</button><a class="btn" href="/setup" target="_blank" rel="noopener">Reconnect or add a bank ↗</a></div>
    </div>
    <div class="block">
      <h2>Accounts</h2>
      <p class="hint">Turn syncing on or off, set how often each account syncs, and edit IDs. New banks are added from the setup page. Leave the token blank to keep the current one.</p>
      <div id="accounts" class="list"></div>
      <div class="actions"><button class="btn primary" data-action="save-accounts">Save accounts</button></div>
    </div>
  </section>

  <section id="tab-recovery" role="tabpanel" aria-label="recovery" class="panel">
    <p class="hint">Detailed transaction-level diagnostics (raw Plaid rows, pending traces, stuck-row detail, and the YNAB register dump) are disabled by default. To use them temporarily, set ENABLE_SENSITIVE_DIAGNOSTICS = "true" in wrangler.toml and redeploy; set it back to "false" when finished. Undo, refresh, webhook configuration, and test alerts remain available.</p>
    <div class="block card item">
      <div class="recovery"><div><strong>Undo a sync</strong><p>Deletes rows a sync created. Rows that have since posted or been reconciled are kept. Previews first.</p></div><button class="btn warning" data-action="undo">Undo…</button></div>
      <div class="recovery"><div><strong>Ask Plaid to refresh</strong><p>Makes Plaid re-poll the banks now, if something visible at the bank hasn't arrived.</p></div><button class="btn" data-action="show-path" data-path="/force-refresh">Refresh Plaid</button></div>
      <div class="recovery"><div><strong>What Plaid sees</strong><p>Raw bank transactions for the selected account (30 days).</p></div><button class="btn" data-action="show-account-path" data-path="/debug/plaid/raw?account={account}&days=30&count=100">Show</button></div>
      <div class="recovery"><div><strong>Why is a pending row stuck?</strong><p>For the selected account: every pending row the worker created, what Plaid says about that charge right now, and why it hasn't moved to posted. Read-only.</p></div><button class="btn" data-action="trace-pending">Explain</button></div>
      <div id="traceOut"></div>
      <div class="recovery"><div><strong>Stuck pending rows (saved automatically)</strong><p>Every hourly health check saves the reason whenever a pending row should have moved to posted but didn't, including rows you've since fixed by hand. Kept 30 days after they're resolved.</p></div><button class="btn" data-action="load-stuck">Refresh</button></div>
      <div id="stuckOut"></div>
      <div class="recovery"><div><strong>What YNAB has</strong><p>The YNAB register for the selected account (30 days), with worker ownership flags.</p></div><button class="btn" data-action="show-account-path" data-path="/debug/ynab-register?account={account}&days=30">Show</button></div>
      <div class="recovery"><div><strong>Re-register webhooks</strong><p>Points every bank login's Plaid webhook at this worker.</p></div><button class="btn" data-action="show-path" data-path="/configure-webhooks">Configure</button></div>
      <div class="recovery"><div><strong>Test alert email</strong><p>Sends a fake "needs reconnect" email to confirm alerts work.</p></div><button class="btn" data-action="show-path" data-path="/test-alert">Send test</button></div>
      <div class="recovery"><div><strong>Live logs</strong><p>From your PC: <code>npx wrangler tail</code> in the project folder.</p></div></div>
    </div>
    <div class="block">
      <h2>Raw output</h2>
      <pre id="output">No output yet.</pre>
    </div>
  </section>
</main>

<script>
var state = { accounts: [], audit: {}, status: {}, items: {}, rules: [], aliases: [], tlabels: [], settings: [] };

function $(id) { return document.getElementById(id); }
function dry() { return $("dryRun").checked; }
function selected() { return $("accountSelect").value; }
function pretty(n) { return String(n || "").split("-").map(function (w) { return w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1); }).join(" "); }
function money(n) { if (n == null || isNaN(n)) return "—"; return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function milli(n) { return money(Number(n || 0) / 1000); }
function when(iso) { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return iso || ""; } }
function ago(iso) {
  if (!iso) return "never";
  var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now"; if (m < 60) return m + " min ago";
  var h = Math.floor(m / 60); return h + " hr" + (m % 60 ? " " + (m % 60) + " min" : "") + " ago";
}

async function api(path, opts, raw) {
  var resp = await fetch(path, Object.assign({}, opts || {}, { credentials: "same-origin", headers: Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {}) }));
  var text = await resp.text();
  var data; try { data = JSON.parse(text); } catch (e) { data = text; }
  // Raw output only shows what you asked to see (Recovery actions and your own
  // actions), not the dashboard's background refreshes.
  if (raw !== false) $("output").textContent = when(new Date().toISOString()) + "  " + path + String.fromCharCode(10) + (typeof data === "string" ? data : JSON.stringify(data, null, 2));
  if (resp.status === 409 && data && data.busy) throw new Error(data.error);
  if (!resp.ok) throw new Error((data && data.error) || ("HTTP " + resp.status));
  return data;
}
function quiet(path) { return api(path, undefined, false); }
async function show(path, btn, method) {
  await busy(btn, async function () {
    try { await api(path, method ? { method: method } : undefined); openTab("recovery"); flash(["Done. The result is under Raw output."], "ok"); } catch (e) { flash([e.message], "bad"); }
  });
}
function needAccount(fn) { var a = selected(); if (!a) { alert("Pick an account in the toolbar first."); return; } fn(encodeURIComponent(a)); }

// Disable a button and mark it busy while its action runs, so it can't be started
// twice and you can see it's working.
async function busy(btn, fn) {
  if (!btn || !btn.tagName) return fn();
  if (btn.getAttribute("aria-busy") === "true") return;
  var label = btn.textContent;
  btn.setAttribute("aria-busy", "true"); btn.disabled = true; btn.textContent = "Running…";
  try { return await fn(); }
  finally { btn.removeAttribute("aria-busy"); btn.disabled = false; btn.textContent = label; }
}

// The result of your last action. It stays until your next action (or 2 minutes),
// separate from the status banner, so refreshing the page data can't erase it.
var flashTimer = null;
function flash(items, level) {
  var el = $("flash");
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  if (!items || !items.length) { el.classList.add("initially-hidden"); el.innerHTML = ""; return; }
  el.classList.remove("initially-hidden");
  el.className = "flash" + (level === "bad" ? " bad" : level === "warn" ? " warn" : "");
  el.innerHTML = "<ul>" + items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
  flashTimer = setTimeout(function () { el.classList.add("initially-hidden"); }, 120000);
}
// Backwards-compatible name used by the rules/settings code for action results.
function attention(items, level) { flash(items, level === "ok" ? "ok" : level); }

// The status banner: exactly what the server says needs attention.
function renderBanner(list) {
  var el = $("attention");
  if (!list || !list.length) { el.classList.add("initially-hidden"); el.innerHTML = ""; return; }
  el.classList.remove("initially-hidden");
  var bad = list.some(function (x) { return x.level === "bad"; });
  el.classList.remove("initially-hidden");
  el.className = "attention" + (bad ? "" : " warn");
  // Only touch the DOM when the text changed, so a screen reader doesn't re-read the
  // whole banner on every refresh.
  var html = "<ul>" + list.map(function (x) { return "<li>" + esc(x.text) + "</li>"; }).join("") + "</ul>";
  if (el.innerHTML !== html) el.innerHTML = html;
}
function setOverall(text, cls) { var el = $("overall"); el.className = "pill " + (cls || ""); el.textContent = text; }

function openTab(name) {
  document.querySelectorAll(".tab").forEach(function (b) { var on = b.getAttribute("data-tab") === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
  document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + name); });
  if (name === "settings") { loadItems(false); loadAccounts(); refreshGlobal(); }
  if (name === "rules") { loadRules(); loadAliases(); loadTLabels(); }
  if (name === "recovery") loadStuck();
}
document.querySelectorAll(".tab").forEach(function (b) {
  b.id = "tabbtn-" + b.getAttribute("data-tab");
  b.tabIndex = b.getAttribute("aria-selected") === "true" ? 0 : -1;
  b.addEventListener("click", function () { openTab(b.getAttribute("data-tab")); });
  // Arrow keys move between tabs (the usual tablist behavior); Home/End jump.
  b.addEventListener("keydown", function (ev) {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    var i = tabs.indexOf(b), j = -1;
    if (ev.key === "ArrowRight") j = (i + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
    else if (ev.key === "Home") j = 0;
    else if (ev.key === "End") j = tabs.length - 1;
    if (j < 0) return;
    ev.preventDefault(); tabs[j].focus(); openTab(tabs[j].getAttribute("data-tab"));
  });
});
document.querySelectorAll(".panel").forEach(function (p) { var n = p.id.replace(/^tab-/, ""); p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", "tabbtn-" + n); p.removeAttribute("aria-label"); });

function updateDryNote() {
  var n = $("dryNote");
  n.textContent = dry() ? "Dry run is on: Sync now and Re-scan only preview and change nothing. Re-check and Transaction reconcile never change anything. Undo always previews and asks you to confirm." : "Dry run is off: Sync now and Re-scan will change YNAB. Re-check and Transaction reconcile never change anything. Undo still previews and asks you to confirm.";
  n.className = dry() ? "note" : "note live";
  document.querySelectorAll(".writes").forEach(function (b) { b.classList.toggle("live", !dry()); });
}
$("dryRun").addEventListener("change", updateDryNote);

// ---------- Overview ----------
async function loadAll() {
  try {
    var h = await quiet("/health");
    state.health = h;
    state.status = {};
    (h.status && h.status.accounts || []).forEach(function (a) { state.status[a.nickname] = a; });
    state.accounts = Object.keys(state.status);
    state.verdicts = h.account_statuses || {};
    fillAccountSelect();
    if (h.last_account_audit && h.last_account_audit.audits) setAudit(h.last_account_audit);
    renderOverview(h);
    // The saved health check came from an older version of the worker (just deployed):
    // run a fresh one once instead of showing what the old code concluded.
    if (!state.autoRechecked && h.worker_version && h.last_account_audit && h.last_account_audit.worker_version !== h.worker_version) {
      state.autoRechecked = true;
      recheck($("btnRecheck") || null);
    }
    renderSkipped(h.skipped_income_history || []);
    loadEvents();
  } catch (e) { setOverall("Error", "bad"); renderBanner([{ level: "bad", text: e.message }]); }
}

function fillAccountSelect() {
  var el = $("accountSelect"), cur = el.value;
  el.innerHTML = '<option value="">All accounts</option>' + state.accounts.map(function (n) { return '<option value="' + esc(n) + '">' + esc(pretty(n)) + "</option>"; }).join("");
  el.value = cur;
}

function setAudit(audit) { state.audit = {}; (audit.audits || []).forEach(function (a) { state.audit[a.account] = a; }); state.auditTs = audit.ts; renderAudit(); }

// Each account's status comes from the server (one computation for the chip, the
// healthy count, the banner and the headline).
function accountLevel(n) {
  var v = (state.verdicts || {})[n];
  if (!v) return ["", "Unknown", "", true];
  return [v.level, v.label, v.secondary || "", v.tracked];
}

// "YNAB is $150.00 below the bank" instead of a bare signed number.
function direction(d) {
  if (d == null || isNaN(d)) return "—";
  if (Math.abs(d) < 0.005) return "matches the bank";
  return "YNAB is " + money(Math.abs(d)) + (d < 0 ? " below" : " above") + " the bank";
}

function renderOverview(h) {
  var healthy = 0, tracked = 0, diff = 0, haveDiff = false, pending = 0, explained = 0, pendingUnknown = false;
  $("accountRows").innerHTML = state.accounts.map(function (n) {
    var st = state.status[n] || {}, a = state.audit[n] || {};
    var lvl = accountLevel(n); if (lvl[3]) { tracked++; if (lvl[0] === "ok") healthy++; }
    var d = a.unavailable ? null : a.unexplained_difference;
    if (d != null) { haveDiff = true; diff += Math.abs(d); }
    explained += Math.abs(Number(a.explained_difference || 0));
    if (a.audit_unavailable) pendingUnknown = true; else pending += Number(a.plaid_pending_count || 0);
    // Of the charges pending at the bank, how many are in YNAB; plus any pending row in
    // YNAB the bank no longer lists (a stuck row), so "nothing pending" never hides one.
    var cov = a.audit_unavailable ? "unknown" : a.pending_purchase_count_total ? (a.pending_purchase_count_covered + " / " + a.pending_purchase_count_total) : (a.account ? "none at the bank" : "—");
    var extraRows = Math.max(0, Number(a.worker_pending_count || 0) - Number(a.pending_purchase_count_covered || 0));
    var covSub = !a.audit_unavailable && extraRows ? "+" + extraRows + " pending in YNAB the bank no longer lists" : "";
    var syncOff = st.automation && st.automation.sync_enabled === false;
    var next = syncOff ? "not synced by the worker" : (st.next_due_minutes ? "next in " + st.next_due_minutes + " min" : "due now");
    var diffText = a.audit_unavailable ? "unknown" : d != null ? money(Math.abs(d)) : (a.account && a.bank_balance == null ? "can't check" : "—");
    var diffSub = a.audit_unavailable ? "health check unavailable" : a.account && a.bank_balance == null ? "bank balance unavailable" : a.explained_difference ? (a.explained_by || money(Math.abs(a.explained_difference)) + " explained") : "";
    if (a.checked_at) diffSub = [diffSub, "checked " + ago(a.checked_at)].filter(Boolean).join(" · ");
    return '<div class="row"><span class="row-name">' + esc(pretty(n)) + (lvl[2] ? '<span class="secondary">' + esc(lvl[2]) + "</span>" : "") + "</span>" +
      '<span class="chip ' + safeCssClass(lvl[0], ["ok", "warn", "bad"]) + '">' + esc(lvl[1]) + '</span>' +
      '<span class="metric">Unexplained difference<strong>' + esc(diffText) + '</strong>' + esc(diffSub) + '</span>' +
      '<span class="metric">Bank pending, in YNAB<strong>' + esc(cov) + '</strong>' + esc(covSub) + '</span>' +
      '<span class="metric">Last synced<strong>' + esc(syncOff ? "n/a" : ago(st.last_account_sync)) + '</strong>' + esc(next) + '</span></div>';
  }).join("") || '<div class="row"><span class="row-name">No accounts yet. <a href="/setup">Add a bank</a> to get started.</span></div>';

  $("kpiHealthy").textContent = tracked ? healthy + " / " + tracked : (state.accounts.length ? "none tracked" : "—");
  $("kpiHealthyNote").textContent = tracked ? "includes accounts that are only health-checked" : "";
  $("kpiDiff").textContent = haveDiff ? money(diff) : "—";
  var diffNotes = [];
  if (explained > 0.01) diffNotes.push("plus " + money(explained) + " explained by named transactions");
  if (state.auditTs) diffNotes.push("as of " + ago(state.auditTs));
  $("kpiDiffNote").textContent = diffNotes.join("; ");
  $("kpiDiff").className = "kpi-value" + (haveDiff && diff > 25 ? " bad" : haveDiff && diff > 0.01 ? " warn" : "");
  $("kpiPending").textContent = pendingUnknown && !pending ? "unknown" : String(pending) + (pendingUnknown ? "+" : "");
  $("kpiPendingAsOf").textContent = state.auditTs ? "as of last health check, " + ago(state.auditTs) + "; card payments not counted" : "";
  $("kpiLast").textContent = h.last_success ? ago(h.last_success.ts) : "never";

  renderBanner(h.attention || []);
  var o;
  if (h.health_status === "error") o = ["Error", "bad"];
  else if (h.health_status === "warning") o = h.attention_level === "bad" ? ["Needs attention", "bad"] : ["Check", "warn"];
  else o = ({ healthy: ["Healthy", "ok"], paused: ["Paused", ""], stale: ["Stale", "warn"], no_success_yet: ["No sync yet", "warn"] })[h.health_status] || ["Unknown", ""];
  setOverall(o[0], o[1]);
}

// ---------- Activity ----------
// Activity shows only entries that changed YNAB, plus the ones that need you (marked).
// Older versions also logged every non-action ("cc_payment_skipped" each hour); those
// are hidden, and older real changes get readable labels.
var EVENT_LABELS = {
  pending_import: "Pending imported", posted_import: "Posted imported", card_payment_transfer: "Card payment transfer",
  pending_flip: "Pending posted", row_update: "Updated", pending_retire: "Pending removed", cc_payment_leg_cleared: "Card leg cleared",
  final_prewrite_dedupe: "Skipped (entered manually)", import_id_rejected: "Rejected by YNAB",
  cc_payment_transfer: "Card payment transfer", card_payment_outflow: "Card payment (outflow)",
  posted_gapfill: "Posted imported", backfill_gapfill: "Posted imported",
  pending_flip_linked: "Pending posted", pending_twin_flip_checking: "Pending posted", duplicate_remove: "Duplicate removed",
  update_failed: "Needs you: update failed", delete_failed: "Needs you: removal failed",
  import_gave_up: "Needs you: not imported", marked_cleared: "Your entry cleared (posted at bank)", too_old_to_import: "Needs you: too old to import", stuck_pending: "Needs you: pending row stuck", cursor_rebuilt: "Bank history replayed",
  matched_existing_row: "Already in YNAB (linked to your row)"
};
var NEEDS_YOU = { update_failed: 1, delete_failed: 1, import_gave_up: 1, too_old_to_import: 1, stuck_pending: 1 };
async function loadEvents() {
  try {
    var d = await quiet("/events?limit=100");
    var ev = (d.events || []).filter(function (e) { return EVENT_LABELS[e.action] && (!selected() || e.account === selected()); });
    // A "Needs you" entry is settled once a later entry shows the same row posted,
    // cleared or removed (events are newest first).
    var FIXED = { pending_flip: 1, marked_cleared: 1, pending_retire: 1, row_update: 1, cc_payment_leg_cleared: 1 };
    var resolved = function (e, i) {
      for (var k = 0; k < i; k++) {
        var x = ev[k];
        if (!FIXED[x.action] || x.account !== e.account) continue;
        if ((e.transaction_id && x.transaction_id === e.transaction_id) || (e.import_id && x.import_id === e.import_id)) return true;
      }
      return false;
    };
    $("events").innerHTML = ev.length ? '<table class="table"><tr><th>When</th><th>Account</th><th>What</th><th class="num">Amount</th><th>Detail</th></tr>' +
      ev.map(function (e, i) {
        var needs = NEEDS_YOU[e.action] && !resolved(e, i);
        var label = (EVENT_LABELS[e.action] || e.action) + (NEEDS_YOU[e.action] && !needs ? " (resolved since)" : "");
        return "<tr" + (needs ? ' class="needs"' : "") + "><td>" + esc(when(e.ts)) + "</td><td>" + esc(pretty(e.account)) + "</td><td>" + esc(label) + '</td><td class="num">' + (e.amount != null ? milli(e.amount) : "") + "</td><td>" + esc(e.detail || "") + "</td></tr>";
      }).join("") + "</table>" : '<div class="empty">No activity recorded yet' + (selected() ? " for " + esc(pretty(selected())) : "") + ".</div>";
  } catch (e) { $("events").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}
function renderSkipped(raw) {
  // Hide card-side payments recorded by older versions, and collapse the repeats
  // those versions wrote on every run.
  var seen = {};
  var list = (raw || []).filter(function (s) {
    if (/^card-side payment/i.test(s.reason || "")) return false;
    var k = [s.account, s.date, s.amount, s.payee].join("|");
    if (seen[k]) return false; seen[k] = true; return true;
  });
  $("skipped").innerHTML = list.length ? '<table class="table"><tr><th>Date</th><th>Account</th><th>Payee</th><th>Reason</th><th class="num">Amount</th></tr>' +
    list.map(function (s) { return "<tr><td>" + esc(s.date) + "</td><td>" + esc(pretty(s.account)) + "</td><td>" + esc(s.payee) + "</td><td>" + esc(s.reason) + '</td><td class="num">' + money(s.amount) + "</td></tr>"; }).join("") + "</table>"
    : '<div class="empty">Nothing has been skipped by your rules.</div>';
}
function describeChange(c) {
  var parts = [];
  if (c.cleared === "cleared") parts.push("mark posted");
  if (c.amount != null) parts.push("amount to " + milli(c.amount));
  if (c.date) parts.push("date to " + c.date);
  if (c.memo === null) parts.push("clear the Pending memo");
  return parts.join(", ") || "update";
}
function renderPreview(data) {
  var rows = [];
  (data.results || []).forEach(function (r) {
    var p = r.plan; if (!p) { rows.push("<tr><td>" + esc(pretty(r.account)) + '</td><td colspan="3">' + esc(String(r.status || "").replace(/^skipped - /, "Skipped: ")) + "</td><td></td></tr>"); return; }
    p.creates.forEach(function (c) { rows.push("<tr><td>" + esc(pretty(r.account)) + "</td><td>Create " + (c.cleared === "uncleared" ? "pending" : "posted") + "</td><td>" + esc(c.date) + "</td><td>" + esc(c.payee_name) + '</td><td class="num">' + milli(c.amount) + "</td></tr>"); });
    p.updates.forEach(function (u) { rows.push("<tr><td>" + esc(pretty(r.account)) + "</td><td>Update</td><td></td><td>" + esc(u.payee) + ": " + esc(describeChange(u.change)) + '</td><td class="num">' + (u.change.amount != null ? milli(u.change.amount) : "") + "</td></tr>"); });
    (p.matched_existing || []).forEach(function (m) { rows.push("<tr><td>" + esc(pretty(r.account)) + "</td><td>Link (no new row)</td><td>" + esc(m.bank_date) + "</td><td>" + esc(m.bank_payee) + ": already in YNAB as your row " + esc(m.ynab_row_payee) + " dated " + esc(m.ynab_row_date) + '</td><td class="num">' + milli(m.amount) + "</td></tr>"); });
    p.deletes.forEach(function (x) { rows.push("<tr><td>" + esc(pretty(r.account)) + "</td><td>Remove</td><td>" + esc(x.date) + "</td><td>" + esc(x.payee) + " (" + esc(x.reason) + ')</td><td class="num">' + milli(x.amount) + "</td></tr>"); });
  });
  $("previewBlock").classList.remove("initially-hidden");
  $("preview").innerHTML = rows.length ? '<div class="card scroll"><table class="table"><tr><th>Account</th><th>Action</th><th>Date</th><th>Payee</th><th class="num">Amount</th></tr>' + rows.join("") + "</table></div>" : '<div class="empty">Nothing to do. YNAB already matches the bank.</div>';
  openTab("activity");
}

// ---------- Actions ----------
function acctQuery(prefix) { return selected() ? prefix + "account=" + encodeURIComponent(selected()) : ""; }

// What a sync actually did, per account, from its response.
function summarizeRun(d, label) {
  if (!d) return { items: [label + ": no response."], level: "bad" };
  if (d.status === "paused") return { items: ["Nothing ran: global sync is paused (Settings)."], level: "warn" };
  if (d.status === "skipped_locked") return { items: [d.note], level: "warn" };
  if (d.status === "lock_unavailable") return { items: [d.note], level: "bad" };
  var items = [], level = "ok";
  (d.results || []).forEach(function (r) {
    var name = pretty(r.account);
    if (r.status === "error" || r.status === "bootstrap_failed") { level = "bad"; items.push(name + ": failed. " + (r.friendly_error || r.error)); return; }
    if (/^skipped/.test(r.status || "")) { items.push(name + ": " + String(r.status).replace(/^skipped - /, "skipped (") + (/^skipped - /.test(r.status) ? ")" : "")); return; }
    var c = r.created_count || 0, u = r.updated_count || 0, x = r.deleted_count || 0;
    var line = name + ": " + (c + u + x ? [c ? c + " added" : "", u ? u + " updated" : "", x ? x + " removed" : ""].filter(Boolean).join(", ") : "no changes needed");
    if (r.status === "partial") { level = level === "bad" ? "bad" : "warn"; line += ". " + (r.partial_note || "Some changes didn't go through; see Activity."); }
    if (r.status === "paused - nothing written") { level = level === "bad" ? "bad" : "warn"; line = name + ": paused before writing; nothing changed."; }
    items.push(line);
  });
  items.unshift(label + (level === "ok" ? " finished." : level === "warn" ? " finished with warnings." : " finished with errors."));
  var pr = d.plaid_refresh;
  if (pr && pr.ok) items.push("Asked the bank for fresh data through Plaid. Anything new lands in a few minutes and syncs on its own.");
  else if (pr) { if (level === "ok") level = "warn"; items.push("Couldn't ask Plaid for fresh bank data (" + ((pr.results || []).map(function (x) { return x.friendly_error || x.error; }).filter(Boolean)[0] || "unknown error") + "), so this used Plaid's cached copy."); }
  return { items: items, level: level };
}

async function runSync(btn) {
  flash([]);
  await busy(btn, async function () {
    try {
      if (dry()) { renderPreview(await api("/dry-run" + acctQuery("?"))); flash(["Dry run: the preview below shows what a live sync would do. Nothing was changed."], "ok"); return; }
      var d = await api("/sync" + acctQuery("?"), { method: "POST" });
      $("previewBlock").classList.add("initially-hidden");
      await loadAll();
      var s = summarizeRun(d, "Sync of " + (selected() ? pretty(selected()) : "all accounts"));
      flash(s.items, s.level);
    } catch (e) { flash([e.message], "bad"); }
  });
}
async function rescan(btn) {
  flash([]);
  await busy(btn, async function () {
    try {
      var d = await api("/backfill-recent?days=" + encodeURIComponent($("rescanDays").value) + "&dryRun=" + (dry() ? "true" : "false") + acctQuery("&"), { method: "POST" });
      if (dry()) { renderPreview(d); flash(["Dry run: the preview below shows what a live Re-scan would do. Nothing was changed."], "ok"); return; }
      await loadAll();
      var s = summarizeRun(d, "Re-scan (" + $("rescanDays").value + " days)");
      flash(s.items, s.level);
    } catch (e) { flash([e.message], "bad"); }
  });
}
async function recheck(btn) {
  flash([]);
  await busy(btn, async function () {
    $("audit").classList.add("is-busy");
    try {
      await loadItems(false);
      var q = selected() ? "?account=" + encodeURIComponent(selected()) : "";
      var audit = await api("/audit/accounts" + q, { method: "POST" });
      // The server stores a one-account check into the saved result, so reloading
      // shows the fresh answer rather than the older one.
      await loadAll();
      var s = audit.summary || {};
      flash(["Re-check of " + (selected() ? pretty(selected()) : "all accounts") + " done: " + (s.healthy || 0) + " healthy, " + (s.warning || 0) + " to check, " + (s.needs_attention || 0) + " needing attention."], (s.needs_attention ? "bad" : s.warning ? "warn" : "ok"));
    } catch (e) { flash([e.message], "bad"); }
    finally { $("audit").classList.remove("is-busy"); }
  });
}
async function undo(btn) {
  await busy(btn, async function () {
    try {
      var list = await api("/undo?list=true");
      if (!list.runs || !list.runs.length) { flash(["Nothing to undo."], "warn"); return; }
      var menu = list.runs.map(function (r) { return r.index + ": " + when(r.ts) + " · " + r.trigger + " · " + r.count + " row(s)"; }).join(String.fromCharCode(10));
      var pick = prompt("Which sync to undo? Enter its number:" + String.fromCharCode(10) + menu, "0");
      if (pick === null) return;
      var preview = await api("/undo?index=" + encodeURIComponent(pick));
      if (!preview.target) { flash([preview.error || "No such sync."], "bad"); return; }
      if (!confirm(preview.message)) return;
      // Confirm by the previewed run's timestamp, never by list position.
      var r = await api("/undo?ts=" + encodeURIComponent(preview.target.ts) + "&confirm=true", { method: "POST" });
      if (r.ok === false && !r.undone) { flash([r.error], "bad"); return; }
      await loadAll();
      flash(["Undo removed " + r.deleted + " row(s)" + (r.kept && r.kept.length ? "; kept " + r.kept.length + " that have settled or are gone" : "") + "." + (r.errors && r.errors.length ? " " + r.errors.length + " couldn't be removed; they stay in the undo list so you can try again." : "")], r.errors && r.errors.length ? "bad" : "ok");
    } catch (e) { flash([e.message], "bad"); }
  });
}

async function loadStuck(btn) {
  await busy(btn, async function () {
    try {
      var d = await api("/debug/stuck-pending", undefined, btn ? undefined : false);
      var list = d.entries || [];
      if (!list.length) { $("stuckOut").innerHTML = '<p class="small m-6-0-12">No stuck pending rows recorded.</p>'; return; }
      $("stuckOut").innerHTML = '<div class="card scroll m-8-0-14"><table class="table"><tr><th>Account</th><th>Row</th><th class="num">Amount</th><th>What Plaid said</th><th>Status</th></tr>' +
        list.map(function (e) {
          var plaid = e.plaid_posted_linked ? "Posted version, linked: " + e.plaid_posted_linked.name + " " + money(e.plaid_posted_linked.amount) + " on " + e.plaid_posted_linked.date
            : (e.unlinked_posted_lookalikes || []).length ? "Posted look-alikes (not linked): " + e.unlinked_posted_lookalikes.map(function (c) { return c.name + " " + money(c.amount) + " on " + c.date; }).join("; ")
            : "No pending or posted version";
          var status = e.resolved_at ? "Resolved " + when(e.resolved_at) : "Still pending in YNAB";
          return "<tr><td>" + esc(pretty(e.account)) + "</td><td>" + esc(e.payee) + "<br><span class='small'>" + esc(e.date) + "</span></td><td class='num'>" + money(e.amount) + "</td><td>" + esc(e.verdict) + "<br><span class='small'>" + esc(plaid) + (e.failure_detail ? "<br>YNAB said: " + esc(e.failure_detail) : "") + "<br>Plaid last got bank data: " + esc(e.plaid_last_bank_update ? when(e.plaid_last_bank_update) : "unknown") + "</span></td><td>" + esc(status) + "<br><span class='small'>first seen " + esc(when(e.first_seen)) + ", " + (e.sightings || 1) + " check(s)</span></td></tr>";
        }).join("") + "</table></div>";
    } catch (e) { flash([e.message], "bad"); }
  });
}

async function tracePending(btn) {
  var a = selected(); if (!a) { alert("Pick an account in the toolbar first."); return; }
  await busy(btn, async function () {
    try {
      var d = await api("/debug/pending-trace?account=" + encodeURIComponent(a));
      var head = '<p class="small p-10-14-0 no-margin"><strong>' + esc(pretty(a)) + ':</strong> Plaid currently lists <strong>' + d.plaid_pending_count + '</strong> pending charge(s); YNAB has <strong>' + d.ynab_uncleared_worker_rows + '</strong> pending row(s) from the worker. Plaid last got data from the bank: ' + esc(d.plaid_last_bank_update ? when(d.plaid_last_bank_update) + " (" + ago(d.plaid_last_bank_update) + ")" : "unknown") + (d.window_truncated ? " · bank data truncated" : "") + "</p>";
      var rows = (d.rows || []).map(function (r) {
        var looks = (r.unlinked_posted_lookalikes || []).map(function (c) { return c.name + " " + money(c.amount) + " on " + c.date; }).join("; ");
        return "<tr><td>" + esc(r.date) + "</td><td>" + esc(r.payee) + '</td><td class="num">' + money(r.amount) + "</td><td>" + esc(r.verdict) + (looks ? '<br><span class="small">Posted look-alikes: ' + esc(looks) + "</span>" : "") + "</td></tr>";
      }).join("");
      $("traceOut").innerHTML = '<div class="card scroll m-8-0-14">' + head + (rows ? '<table class="table"><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th>What Plaid says about it</th></tr>' + rows + "</table>" : '<p class="small p-0-14-10">No pending rows from the worker.</p>') + "</div>";
    } catch (e) { flash([e.message], "bad"); }
  });
}

// ---------- Account health ----------
function reconcileAccount(n) {
  $("accountSelect").value = n; loadEvents();
  openTab("reconcile"); runReconcile();
}
function renderAudit() {
  var names = state.accounts.length ? state.accounts : Object.keys(state.audit);
  $("audit").innerHTML = names.map(function (n) {
    var a = state.audit[n]; if (!a) return "";
    var lvl = accountLevel(n);
    var kv = function (k, v) { return '<div class="kv"><span>' + esc(k) + "</span><span>" + esc(v) + "</span></div>"; };
    var cands = (a.missing_balance_transactions || []).slice(0, 8).map(function (t) {
      return "<li>" + esc((t.source === "ynab" ? "In YNAB only: " : "At bank only: ") + t.date + " · " + t.payee + " · " + money(t.amount) + " · " + (t.confidence === "exact_delta" ? "explains the difference exactly" : t.confidence === "delta_combination" ? "explains it with another item" : "possible")) + "</li>";
    }).join("");
    return '<div class="card item"><h3>' + esc(pretty(n)) + ' <span class="chip ' + safeCssClass(lvl[0], ["ok", "warn", "bad"]) + '">' + esc(lvl[1]) + "</span>" + (lvl[2] ? ' <span class="small">' + esc(lvl[2]) + "</span>" : "") + "</h3>" +
      kv("Bank balance", money(a.bank_balance)) + kv("YNAB balance", money(a.ynab_balance)) +
      kv("Difference", esc(direction(a.balance_difference))) +
      (a.expected_difference ? kv("Expected (front-loaded, in transit, awaiting Direct Import)", money(a.expected_difference)) : "") +
      (a.explained_difference ? kv("Explained by the transactions below", money(a.explained_difference)) : "") +
      kv("Unexplained", money(a.unexplained_difference)) +
      ((a.attention_reasons || []).length ? '<p class="small"><strong>Needs attention:</strong> ' + a.attention_reasons.map(esc).join(" ") + "</p>" : "") +
      kv("Pending at bank in YNAB", a.audit_unavailable ? "unknown" : (a.pending_purchase_count_covered || 0) + " / " + (a.pending_purchase_count_total || 0)) +
      (a.stale_pending_count ? kv("Stale pending rows", a.stale_pending_count) : "") +
      '<p class="small">Bank balance: ' + esc(a.balance_source || "unavailable") + (a.checked_at ? " · checked " + esc(ago(a.checked_at)) : "") + "</p>" +
      (cands ? '<p class="small"><strong>Possible explanations</strong></p><ul class="small">' + cands + "</ul>" : "") +
      ((a.warnings || []).length ? '<ul class="small">' + a.warnings.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul>" : "") +
      ((a.notes || []).length ? '<p class="small">' + a.notes.map(esc).join("<br>") + "</p>" : "") +
      '<div class="actions"><button class="btn" data-recon="' + esc(n) + '">Reconcile this account row by row</button></div>' + "</div>";
  }).join("") || '<div class="empty">No health check yet. Click Re-check.</div>';
  $("audit").querySelectorAll("[data-recon]").forEach(function (b) { b.addEventListener("click", function () { reconcileAccount(b.getAttribute("data-recon")); }); });
  if (state.auditTs) $("audit").insertAdjacentHTML("afterbegin", '<p class="small">Health check from ' + esc(when(state.auditTs)) + " (" + esc(ago(state.auditTs)) + ")</p>");
}

// ---------- Reconcile ----------
async function runReconcile(btn) {
  await busy(btn, async function () {
  $("recon").innerHTML = '<div class="empty">Comparing…</div>';
  try {
    var q = "?days=" + $("reconDays").value + (selected() ? "&account=" + encodeURIComponent(selected()) : "");
    var d = await api("/reconcile" + q);
    var cell = function (x, c) {
      var v = x[c[1]];
      if (c[2]) return money(v);
      if (c[1] === "pending") return v ? "pending" : "posted";
      return esc(v == null ? "" : v);
    };
    var table = function (list, cols) {
      if (!list.length) return '<p class="small">None.</p>';
      return '<div class="scroll"><table class="table"><tr>' + cols.map(function (c) { return "<th" + (c[2] ? ' class="num"' : "") + ">" + c[0] + "</th>"; }).join("") + "</tr>" +
        list.map(function (x) { return "<tr>" + cols.map(function (c) { return "<td" + (c[2] ? ' class="num"' : "") + ">" + cell(x, c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table></div>";
    };
    $("recon").innerHTML = (d.results || []).map(function (r) {
      if (r.error) return '<div class="card item"><h3>' + esc(pretty(r.account)) + '</h3><p class="small">' + esc(r.error) + "</p></div>";
      var mism = r.direction_mismatch || [];
      var diPending = r.bank_pending_direct_import || [];
      var amt = r.amount_mismatch || [];
      var cbp = r.cleared_but_pending || [];
      var pbu = r.posted_but_uncleared || [];
      var issues = r.bank_only_count + r.ynab_only_count + mism.length + amt.length + cbp.length;
      var clean = !issues;
      return '<div class="card item"><h3>' + esc(pretty(r.account)) + ' <span class="chip ' + (clean ? "ok" : "warn") + '">' + (clean ? "Matches" : issues + " to review") + "</span></h3>" +
        '<p class="small">Since ' + esc(r.window_start) + " · " + r.bank_count + " bank rows · " + r.ynab_register_count + " YNAB rows" + (r.truncated ? " · bank data truncated" : "") + " · bank feed last updated " + esc(r.feed_updated_at ? when(r.feed_updated_at) + " (" + ago(r.feed_updated_at) + ")" : "unknown") + "</p>" +
        (r.balance_check ? "<p><strong>Balance</strong> <span class='small'>(YNAB cleared " + money(r.balance_check.ynab_cleared) + " vs bank posted " + money(r.balance_check.bank_posted) + (Math.abs(r.balance_check.difference) > 0.01 ? ", off by " + money(r.balance_check.difference) : "") + ")</span></p><p class='small'>" + esc(r.balance_check.note) + "</p>" : "") +
        (mism.length ? "<p><strong>On both sides, opposite direction</strong> <span class='small'>(one side has it as money in, the other as money out; fix whichever is wrong)</span></p>" + table(mism, [["Date", "date"], ["Bank", "name"], ["Bank amount", "bank_amount", 1], ["YNAB amount", "ynab_amount", 1], ["Balance effect", "balance_effect", 1]]) : "") +
        (amt.length ? "<p><strong>On both sides, different amount</strong> (YNAB is off by " + money(r.amount_mismatch_total) + ") <span class='small'>(the bank posted a different amount than the YNAB row has, e.g. a tip; change the YNAB row to the bank amount)</span></p>" + table(amt, [["Date", "date"], ["Payee", "payee"], ["YNAB", "ynab_amount", 1], ["Bank", "bank_amount", 1], ["YNAB status", "ynab_status"]]) : "") +
        (cbp.length ? "<p><strong>Cleared in YNAB, still pending at the bank</strong> (" + money(r.cleared_but_pending_total) + ") <span class='small'>(YNAB's cleared balance differs from the bank's balance by this much until the bank posts it; nothing is missing)</span></p>" + table(cbp, [["Date", "date"], ["Payee", "payee"], ["YNAB status", "ynab_status"], ["Amount", "amount", 1]]) : "") +
        (pbu.length ? "<p><strong>Posted at the bank, still uncleared in YNAB</strong> <span class='small'>(the next sync marks these cleared)</span></p>" + table(pbu, [["Date", "date"], ["Payee", "payee"], ["Amount", "amount", 1]]) : "") +
        "<p><strong>At the bank, missing from YNAB</strong> (" + money(r.bank_only_total) + ")</p>" + table(r.bank_only, [["Date", "date"], ["Name", "name"], ["Status", "pending"], ["Amount", "amount", 1]]) +
        "<p><strong>In YNAB, not at the bank</strong> (" + money(r.ynab_only_total) + ")</p>" + table(r.ynab_only, [["Date", "date"], ["Payee", "payee"], ["Status", "cleared"], ["Amount", "amount", 1]]) +
        ((r.ynab_on_the_way || []).length ? "<p><strong>On the way from your other account</strong> <span class='small'>(booked when your other bank showed it pending; this bank shows it in a day or so)</span></p>" + table(r.ynab_on_the_way, [["Date", "date"], ["Payee", "payee"], ["Status", "cleared"], ["Amount", "amount", 1]]) : "") +
        ((r.ynab_newer_than_feed || []).length ? "<p><strong>Newer than the bank feed</strong> <span class='small'>(dated on or after the feed's last update; the feed often runs hours behind your bank's app, so these usually match on the next update)</span></p>" + table(r.ynab_newer_than_feed, [["Date", "date"], ["Payee", "payee"], ["Status", "cleared"], ["Amount", "amount", 1]]) : "") +
        ((r.ynab_entered_ahead || []).length ? "<p><strong>Entered ahead of the bank</strong> <span class='small'>(covered by your skip rules; the bank feed hasn't shown them yet, so this is expected)</span></p>" + table(r.ynab_entered_ahead, [["Date", "date"], ["Payee", "payee"], ["Status", "cleared"], ["Amount", "amount", 1]]) : "") +
        (diPending.length ? "<p><strong>Pending at the bank</strong> <span class='small'>(Direct Import hasn't brought these in yet; not a problem)</span></p>" + table(diPending, [["Date", "date"], ["Name", "name"], ["Amount", "amount", 1]]) : "") +
        (r.bank_skipped_count ? "<p><strong>Skipped on purpose</strong></p>" + table(r.bank_skipped, [["Date", "date"], ["Name", "name"], ["Reason", "reason"], ["Amount", "amount", 1]]) : "") +
        ((r.ynab_adjustments || []).length ? "<p><strong>Reconciliation adjustments and starting balance</strong> <span class='small'>(created by YNAB, not bank transactions)</span></p>" + table(r.ynab_adjustments, [["Date", "date"], ["Payee", "payee"], ["Status", "cleared"], ["Amount", "amount", 1]]) : "") + "</div>";
    }).join("") || '<div class="empty">No accounts are health-checked, so there is nothing to compare.</div>';
  } catch (e) { $("recon").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
  });
}

// ---------- Rules ----------
function accountOptions(sel, withAll) {
  var opts = (withAll ? [["*", "All accounts"]] : []).concat(state.accounts.map(function (n) { return [n, pretty(n)]; }));
  return opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === sel ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("");
}
async function loadRules() { try { state.rules = (await quiet("/skip-rules")).rules || []; renderRules(); } catch (e) { attention([e.message], "bad"); } }
function renderRules() {
  $("rules").innerHTML = state.rules.length ? state.rules.map(function (r, i) {
    return '<div class="card item"><div class="grid2">' +
      '<div class="full"><label class="inline"><input type="checkbox" data-r="' + i + '" data-f="enabled"' + (r.enabled !== false ? " checked" : "") + " /> Enabled</label></div>" +
      '<div><span class="field-label">Account</span><select aria-label="Account" data-r="' + i + '" data-f="account">' + accountOptions(r.account, true) + "</select></div>" +
      '<div><span class="field-label">Direction</span><select aria-label="Direction" data-r="' + i + '" data-f="transaction_type">' +
        [["inflow", "Money in"], ["outflow", "Money out"], ["any", "Either"]].map(function (o) { return '<option value="' + o[0] + '"' + (r.transaction_type === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select></div>" +
      '<div><span class="field-label">Bank text contains</span><input aria-label="Bank text contains" data-r="' + i + '" data-f="contains" value="' + esc(r.contains) + '" /></div>' +
      '<div><span class="field-label">Only these amounts (optional)</span><input aria-label="Only these amounts (optional)" data-r="' + i + '" data-f="amounts" value="' + esc((r.amounts || []).join(", ")) + '" placeholder="Any amount" /></div>' +
      '<div class="full"><span class="field-label">Why</span><input aria-label="Why" data-r="' + i + '" data-f="reason" value="' + esc(r.reason) + '" /></div>' +
      '</div><div class="actions"><button class="btn ghost" data-action="delete-rule" data-index="' + i + '">Delete rule</button></div></div>';
  }).join("") : '<div class="empty">No rules. The worker imports everything.</div>';
  $("rules").querySelectorAll("[data-r]").forEach(function (el) {
    el.addEventListener("input", function () {
      var r = state.rules[Number(el.getAttribute("data-r"))], f = el.getAttribute("data-f");
      if (f === "enabled") r.enabled = el.checked;
      else if (f === "amounts") r.amounts = el.value.split(",").map(function (x) { return Number(x.trim()); }).filter(function (x) { return x > 0; });
      else r[f] = el.value;
    });
  });
}
// Delete saves right away. (It used to only remove the card on screen; switching tabs
// reloaded the saved rules and the "deleted" one came back.)
async function deleteRule(i) {
  var r = state.rules[i];
  if (!confirm("Delete the rule " + (r.contains ? '"' + r.contains + '"' : "") + "? This is saved immediately.")) return;
  var next = state.rules.filter(function (_, j) { return j !== i; });
  try {
    state.rules = (await api("/skip-rules", { method: "POST", body: JSON.stringify({ rules: next }) })).rules;
    renderRules(); attention(["Rule deleted."], "ok");
  } catch (e) { attention([e.message], "bad"); }
}
function addRule() { state.rules.push({ id: "rule-" + Date.now(), enabled: true, account: state.accounts[0] || "*", contains: "", transaction_type: "inflow", reason: "Entered manually in YNAB" }); renderRules(); }
async function saveRules() {
  try { state.rules = (await api("/skip-rules", { method: "POST", body: JSON.stringify({ rules: state.rules }) })).rules; renderRules(); attention(["Skip rules saved."], "ok"); }
  catch (e) { attention([e.message], "bad"); }
}
async function resetRules() {
  if (!confirm("Replace your rules with the built-in defaults?")) return;
  try { state.rules = (await api("/skip-rules/reset", { method: "POST" })).rules; renderRules(); } catch (e) { attention([e.message], "bad"); }
}
async function loadAliases() { try { state.aliases = (await quiet("/payee-aliases")).aliases || []; renderAliases(); } catch (e) { attention([e.message], "bad"); } }
function renderAliases() {
  $("aliases").innerHTML = state.aliases.length ? state.aliases.map(function (g, i) {
    return '<div class="card item"><div class="grid2"><div><span class="field-label">Merchant</span><input aria-label="Merchant" data-a="' + i + '" data-f="canonical" value="' + esc(g.canonical) + '" /></div>' +
      '<div><span class="field-label">Names that mean it (comma-separated)</span><input aria-label="Names that mean it (comma-separated)" data-a="' + i + '" data-f="patterns" value="' + esc((g.patterns || []).join(", ")) + '" /></div></div>' +
      '<div class="actions"><button class="btn ghost" data-action="delete-alias" data-index="' + i + '">Remove group</button></div></div>';
  }).join("") : '<div class="empty">No aliases.</div>';
  $("aliases").querySelectorAll("[data-a]").forEach(function (el) {
    el.addEventListener("input", function () {
      var g = state.aliases[Number(el.getAttribute("data-a"))], f = el.getAttribute("data-f");
      g[f] = f === "patterns" ? el.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : el.value;
    });
  });
}
async function deleteAlias(i) {
  var g = state.aliases[i];
  if (!confirm("Remove the alias group " + (g.canonical ? '"' + g.canonical + '"' : "") + "? This is saved immediately.")) return;
  var next = state.aliases.filter(function (_, j) { return j !== i; });
  try {
    state.aliases = (await api("/payee-aliases", { method: "POST", body: JSON.stringify({ aliases: next }) })).aliases;
    renderAliases(); attention(["Alias group removed."], "ok");
  } catch (e) { attention([e.message], "bad"); }
}
function addAlias() { state.aliases.push({ canonical: "", patterns: [] }); renderAliases(); }
async function saveAliases() {
  try { state.aliases = (await api("/payee-aliases", { method: "POST", body: JSON.stringify({ aliases: state.aliases }) })).aliases; renderAliases(); attention(["Aliases saved."], "ok"); }
  catch (e) { attention([e.message], "bad"); }
}

async function loadTLabels() { try { state.tlabels = (await quiet("/transfer-labels")).labels || []; renderTLabels(); } catch (e) { attention([e.message], "bad"); } }
function renderTLabels() {
  $("tlabels").innerHTML = state.tlabels.length ? state.tlabels.map(function (l, i) {
    return '<div class="card item"><div class="grid2"><div><span class="field-label">Last digits</span><input aria-label="Last digits" inputmode="numeric" data-t="' + i + '" data-f="tail" value="' + esc(l.tail) + '" /></div>' +
      '<div><span class="field-label">Payee name</span><input aria-label="Payee name" data-t="' + i + '" data-f="label" value="' + esc(l.label) + '" /></div></div>' +
      '<div class="actions"><button class="btn ghost" data-action="delete-transfer-label" data-index="' + i + '">Remove</button></div></div>';
  }).join("") : '<div class="empty">No labels.</div>';
  $("tlabels").querySelectorAll("[data-t]").forEach(function (el) {
    el.addEventListener("input", function () { state.tlabels[Number(el.getAttribute("data-t"))][el.getAttribute("data-f")] = el.value; });
  });
}
function addTLabel() { state.tlabels.push({ tail: "", label: "" }); renderTLabels(); }
async function deleteTLabel(i) { state.tlabels = state.tlabels.filter(function (_, j) { return j !== i; }); await saveTLabels(); }
async function saveTLabels() {
  try { state.tlabels = (await api("/transfer-labels", { method: "POST", body: JSON.stringify({ labels: state.tlabels }) })).labels; renderTLabels(); attention(["Transfer labels saved."], "ok"); }
  catch (e) { attention([e.message], "bad"); }
}

// ---------- Settings ----------
async function refreshGlobal() {
  try {
    var h = await quiet("/health");
    $("globalState").className = "chip " + (h.sync_enabled ? "ok" : "warn");
    $("globalState").textContent = h.sync_enabled ? "Running" : "Paused";
    $("globalBtn").textContent = h.sync_enabled ? "Pause all syncing" : "Resume syncing";
    $("globalBtn").className = "btn " + (h.sync_enabled ? "warning" : "primary");
    $("globalBtn").setAttribute("data-on", h.sync_enabled ? "1" : "0");
  } catch (e) { $("globalState").textContent = "unknown"; }
}
async function toggleGlobal() {
  var on = $("globalBtn").getAttribute("data-on") === "1";
  if (on && !confirm("Pause all syncing? Nothing imports until you resume.")) return;
  try { await api(on ? "/pause" : "/resume"); await refreshGlobal(); loadAll(); } catch (e) { attention([e.message], "bad"); }
}
async function saveToken() {
  var v = $("token").value.trim(); if (!v) return;
  try {
    var resp = await fetch("/session", { method: "POST", credentials: "same-origin", headers: { "x-admin-token": v } });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Authentication failed.");
    $("token").value = "";
    await loadAll(); loadItems(false);
    attention(["Authenticated. The admin token is held in an HttpOnly browser cookie, not Web Storage."], "ok");
  } catch (e) { attention([e.message], "bad"); }
}
async function clearToken() {
  await fetch("/session", { method: "DELETE", credentials: "same-origin" });
  setOverall("No token", ""); attention(["Admin browser session cleared."], "ok");
}

async function loadItems(force) {
  try {
    var d = await api("/item-health" + (force ? "?force=true" : ""), force ? { method: "POST" } : undefined, force ? undefined : false);
    state.items = {};
    (d.items || []).forEach(function (it) { (it.nicknames || []).forEach(function (n) { state.items[n] = it; }); });
    $("items").innerHTML = (d.items || []).map(function (it) {
      var lvl = it.status === "needs_reauth" ? ["bad", "Needs reauth"] : it.status === "error" ? ["warn", "Connection error"] : it.status === "stale" ? ["warn", "No new bank data"] : it.status === "healthy" ? ["ok", "Healthy"] : ["", "Unknown"];
      return '<div class="card item"><h3>' + esc(it.institution || (it.nicknames || []).map(pretty).join(", ")) + ' <span class="chip ' + safeCssClass(lvl[0], ["ok", "warn", "bad"]) + '">' + lvl[1] + '</span></h3><p class="small">' + esc((it.nicknames || []).map(pretty).join(", ")) + " · checked " + esc(ago(it.last_check)) + (it.last_bank_update ? " · bank data from " + esc(ago(it.last_bank_update)) : "") + (it.error ? " · " + esc(it.error) : "") + (it.alert_failed ? " · alert email failed, will retry" : "") + "</p></div>";
    }).join("") || '<div class="empty">No data yet. Click Check now.</div>';
  } catch (e) { /* non-fatal */ }
}

async function loadAccounts() {
  try {
    var a = await quiet("/accounts"), s = await quiet("/account-settings");
    state.acctRows = a.accounts || [];
    state.settings = s.settings || [];
    $("accounts").innerHTML = state.acctRows.map(function (r, i) {
      var st = state.settings.find(function (x) { return x.nickname === r.nickname; }) || {};
      var freq = [15, 30, 60, 120, 240].map(function (m) { return '<option value="' + m + '"' + (st.sync_frequency_minutes === m ? " selected" : "") + ">Every " + (m < 60 ? m + " min" : (m / 60) + " hr") + "</option>"; }).join("");
      return '<div class="card item" data-acct="' + i + '"><h3>' + esc(pretty(r.nickname)) + ' <span class="small">' + esc(r.institution || "") + (r.has_token ? " · connected" : " · no token") + "</span></h3><div class='grid2'>" +
        '<div><label class="inline"><input type="checkbox" data-f="sync_enabled"' + (st.sync_enabled !== false ? " checked" : "") + ' /> Sync: the worker writes to this account</label></div>' +
        '<div><span class="field-label">Frequency</span><select aria-label="Frequency" data-f="sync_frequency_minutes">' + freq + "</select></div>" +
        (r.is_credit_card
          ? '<div><span class="small">Cards always import from the recent window (safety net); there is no switch for it.</span></div>'
          : '<div><label class="inline"><input type="checkbox" data-f="backfill_enabled"' + (st.backfill_enabled ? " checked" : "") + ' /> Import from the recent window (safety net)</label></div>') +
        '<div><label class="inline"><input type="checkbox" data-f="audit_enabled"' + (st.audit_enabled !== false ? " checked" : "") + ' /> Include in health checks (read-only)</label></div>' +
        '<div><label class="inline"><input type="checkbox" data-f="is_credit_card"' + (r.is_credit_card ? " checked" : "") + ' /> Credit card</label></div>' +

        (r.is_credit_card
          ? '<div><span class="field-label">Payments name it by last 4</span><input aria-label="Payments name it by last 4" data-f="payment_last4" placeholder="e.g. 1234" value="' + esc(((r.payment_match || {}).last4 || []).join(", ")) + '" /></div>' +
            '<div><span class="field-label">...or by words</span><input aria-label="...or by words" data-f="payment_words" placeholder="e.g. sapphire" value="' + esc(((r.payment_match || {}).words || []).join(", ")) + '" /></div>' +
            '<div class="full"><span class="small">How a payment from checking is recognized as paying this card, so it is booked as a transfer. Comma separated.</span></div>'
          : "") +
        '<details class="adv full"><summary>Advanced: account ids and token</summary><div class="grid2">' +
        '<div><span class="field-label">Institution</span><input aria-label="Institution" data-f="institution" value="' + esc(r.institution) + '" /></div>' +
        '<div><span class="field-label">YNAB account id</span><input aria-label="YNAB account id" data-f="ynab_account_id" value="' + esc(r.ynab_account_id) + '" /></div>' +
        '<div><span class="field-label">Plaid account id</span><input aria-label="Plaid account id" data-f="plaid_account_id" value="' + esc(r.plaid_account_id) + '" /></div>' +
        '<div class="full"><span class="field-label">Replace access token (leave blank to keep)</span><input aria-label="Replace access token (leave blank to keep)" type="password" data-f="plaid_access_token" autocomplete="off" /></div>' +
        "</div></details></div></div>";
    }).join("") || '<div class="empty">No accounts yet. <a href="/setup">Add a bank</a>.</div>';
  } catch (e) { $("accounts").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; }
}
async function saveAccounts() {
  var accounts = [], settings = [];
  document.querySelectorAll("[data-acct]").forEach(function (card) {
    var r = state.acctRows[Number(card.getAttribute("data-acct"))];
    var val = function (f) { var el = card.querySelector('[data-f="' + f + '"]'); if (!el) return undefined; return el.type === "checkbox" ? el.checked : el.value.trim(); };
    var row = { nickname: r.nickname, institution: val("institution"), ynab_account_id: val("ynab_account_id"), plaid_account_id: val("plaid_account_id"), item_id: r.item_id, is_credit_card: val("is_credit_card") };
    if (val("plaid_access_token")) row.plaid_access_token = val("plaid_access_token");
    if (val("payment_last4") !== undefined) row.payment_match = { last4: val("payment_last4"), words: val("payment_words") };
    accounts.push(row);
    settings.push({ nickname: r.nickname, sync_enabled: val("sync_enabled"), backfill_enabled: val("backfill_enabled"), sync_frequency_minutes: Number(val("sync_frequency_minutes")), audit_enabled: val("audit_enabled") });
  });
  try {
    await api("/accounts/save", { method: "POST", body: JSON.stringify({ accounts: accounts, settings: settings }) });
    attention(["Accounts saved. Changes apply on the next sync."], "ok");
    loadAccounts(); loadAll();
  } catch (e) { attention([e.message], "bad"); }
}


document.addEventListener("click", function (event) {
  var target = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
  if (!target) return;
  var action = target.getAttribute("data-action");
  var index = Number(target.getAttribute("data-index"));
  switch (action) {
    case "run-sync": runSync(target); break;
    case "recheck": recheck(target); break;
    case "rescan": rescan(target); break;
    case "run-reconcile": runReconcile(target); break;
    case "add-rule": addRule(); break;
    case "save-rules": saveRules(); break;
    case "add-alias": addAlias(); break;
    case "save-aliases": saveAliases(); break;
    case "add-transfer-label": addTLabel(); break;
    case "save-transfer-labels": saveTLabels(); break;
    case "toggle-global": toggleGlobal(); break;
    case "save-token": saveToken(); break;
    case "clear-token": clearToken(); break;
    case "check-items": loadItems(true); break;
    case "save-accounts": saveAccounts(); break;
    case "undo": undo(target); break;
    case "show-path": show(target.getAttribute("data-path"), target, "POST"); break;
    case "show-account-path":
      needAccount(function (account) { show(target.getAttribute("data-path").replace("{account}", account), target); });
      break;
    case "trace-pending": tracePending(target); break;
    case "load-stuck": loadStuck(target); break;
    case "delete-rule": deleteRule(index); break;
    case "delete-alias": deleteAlias(index); break;
    case "delete-transfer-label": deleteTLabel(index); break;
  }
});

// ---------- Start ----------
(async function init() {
  // Remove credentials saved by older releases; this build uses HttpOnly cookies.
  sessionStorage.removeItem("ynab_sync_admin_token");
  var hashToken = "";
  if (location.hash.indexOf("token=") >= 0) {
    hashToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    history.replaceState(null, "", location.pathname);
  }
  $("accountSelect").addEventListener("change", function () { loadEvents(); $("traceOut").innerHTML = ""; });
  updateDryNote();
  if (hashToken) {
    $("token").value = hashToken;
    await saveToken();
    return;
  }
  try {
    await api("/session", undefined, false);
    loadAll();
    loadItems(false);
  } catch (e) {
    setOverall("No token", "");
    attention(["Add your admin token under Settings."], "warn");
    openTab("settings");
  }
})();
</script>
</body>
</html>`;

  const securedHtml = html.replace(/<script(?![^>]*\bnonce=)/gi, '<script nonce="' + nonce + '"')
    .replace(/<style(?![^>]*\bnonce=)/gi, '<style nonce="' + nonce + '"');
  return new Response(securedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...NO_FRAMING,
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'nonce-" + nonce + "'; script-src-attr 'none'; style-src 'nonce-" + nonce + "'; style-src-attr 'none'; img-src 'self' data: https:; connect-src 'self'; frame-src 'none'; font-src 'self' data:"
    }
  });
}
