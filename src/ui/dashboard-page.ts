import { newCspNonce, pageSecurityHeaders } from "../util/http";
import { escapeHtml as esc, safeCssClass } from "../util/html";

export function dashboardHtml(nonce: string = newCspNonce()): Response {
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
    .row { display: grid; grid-template-columns: minmax(150px, 1.2fr) 160px minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: center; padding: 14px 22px; }
    .row > .chip { justify-self: start; }
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

  <div id="flash" class="flash" role="status" aria-live="polite" style="display:none"></div>
  <section id="attention" class="attention" role="status" aria-live="polite" style="display:none"></section>

  <div id="accountRows" class="card rows"><div class="row"><span class="row-name">Loading…</span></div></div>

  <div class="card toolbar">
    <button id="btnSync" class="btn primary writes" data-click="runSync">Sync now</button>
    <button id="btnRecheck" class="btn" data-click="recheck" title="Read-only: re-reads the bank and YNAB balances and updates Account health">Re-check</button>
    <button id="btnRescan" class="btn writes" data-click="rescan" title="Look for bank transactions missing from YNAB, over the chosen number of days">Re-scan</button>
    <select id="rescanDays" aria-label="How far back Re-scan looks" title="How far back Re-scan looks"><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
    <a class="btn" href="https://app.ynab.com/" target="_blank" rel="noopener">Open YNAB ↗</a>
    <a class="btn ghost" href="https://github.com/MikeAllen1/ynab-sync-plaid/blob/main/docs/GLOSSARY.md" target="_blank" rel="noopener" title="What Sync now, Re-check, Re-scan, Undo and the Activity labels mean">What do these mean? ↗</a>
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
    <div class="block" id="previewBlock" style="display:none">
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
      <div class="actions"><label class="inline">Days <select id="reconDays"><option>7</option><option selected>14</option><option>21</option><option>30</option><option>60</option><option>90</option></select></label><button class="btn primary" data-click="runReconcile">Run reconcile</button></div>
      <div id="recon" class="list" style="margin-top:14px"></div>
    </div>
  </section>

  <section id="tab-rules" role="tabpanel" aria-label="rules" class="panel">
    <div class="block">
      <h2>Skip rules</h2>
      <p class="hint">Bank items the worker should never import. There are none unless you add one: everything that affects a balance is imported. Delete takes effect immediately; edits and new rules need <strong>Save rules</strong>.</p>
      <div id="rules" class="list"></div>
      <div class="actions">
        <button class="btn" data-click="addRule">+ Add rule</button>
        <button class="btn primary" data-click="saveRules">Save rules</button>
      </div>
    </div>
    <div class="block">
      <h2>Payee aliases</h2>
      <p class="hint">When the bank and YNAB name the same merchant differently (an old brand name vs the new one), group the names so they match.</p>
      <div id="aliases" class="list"></div>
      <div class="actions">
        <button class="btn" data-click="addAlias">+ Add group</button>
        <button class="btn primary" data-click="saveAliases">Save aliases</button>
      </div>
    </div>
    <div class="block">
      <h2>Transfer labels</h2>
      <p class="hint">Name transfers to and from your own accounts at other banks by the last digits the bank shows (&ldquo;&hellip;1234&rdquo;), so YNAB gets a stable payee it can learn a category for.</p>
      <div id="tlabels" class="list"></div>
      <div class="actions">
        <button class="btn" data-click="addTLabel">+ Add label</button>
        <button class="btn primary" data-click="saveTLabels">Save labels</button>
      </div>
    </div>
  </section>

  <section id="tab-settings" role="tabpanel" aria-label="settings" class="panel">
    <div class="block">
      <h2>Global sync</h2>
      <p class="hint">Master switch. While paused nothing is written and Plaid is not asked to refresh. Dry runs still work.</p>
      <div class="actions"><span id="globalState" class="chip">…</span><button id="globalBtn" class="btn warning" data-click="toggleGlobal">…</button></div>
    </div>
    <div class="block">
      <h2>Admin token</h2>
      <p class="hint">Stored only in this browser.</p>
      <div class="grid2"><div><input id="token" type="password" placeholder="Admin token" aria-label="Admin token" autocomplete="off" /></div><div class="actions" style="margin:0"><button class="btn primary" data-click="saveToken">Save</button><button class="btn ghost" data-click="clearToken">Sign out</button></div></div>
    </div>
    <div class="block">
      <h2>Bank connections</h2>
      <p class="hint">Checked about every 6 hours. "Needs reauth" means the bank must be reconnected before its data goes stale.</p>
      <div id="items" class="list"></div>
      <div class="actions"><button class="btn" data-click="loadItemsFresh">Check now</button><a class="btn" href="/setup" target="_blank" rel="noopener">Reconnect or add a bank ↗</a></div>
    </div>
    <div class="block">
      <h2>Accounts</h2>
      <p class="hint">Turn syncing on or off, set how often each account syncs, and edit IDs. New banks are added from the setup page. Leave the token blank to keep the current one.</p>
      <div id="accounts" class="list"></div>
      <div class="actions"><button class="btn primary" data-click="saveAccounts">Save accounts</button></div>
    </div>
  </section>

  <section id="tab-recovery" role="tabpanel" aria-label="recovery" class="panel">
    <div class="block card item">
      <div class="recovery"><div><strong>Undo a sync</strong><p>Removes the rows a sync added. It does not reverse anything else that sync did (rows it marked posted, pending rows it removed, amounts it updated). Rows that have since posted or been reconciled are kept. Previews first.</p></div><button class="btn warning" data-click="undo">Undo…</button></div>
      <div class="recovery"><div><strong>Ask Plaid to refresh</strong><p>Makes Plaid re-poll the banks now, if something visible at the bank hasn't arrived.</p></div><button class="btn" data-click="show" data-path="/force-refresh" data-method="POST">Refresh Plaid</button></div>
      <div class="recovery"><div><strong>What Plaid sees</strong><p>Raw bank transactions for the selected account (30 days).</p></div><button class="btn" data-click="showPlaidRaw">Show</button></div>
      <div class="recovery"><div><strong>Why is a pending row stuck?</strong><p>For the selected account: every pending row the worker created, what Plaid says about that charge right now, and why it hasn't moved to posted. Read-only.</p></div><button class="btn" data-click="tracePending">Explain</button></div>
      <div id="traceOut"></div>
      <div class="recovery"><div><strong>Stuck pending rows (saved automatically)</strong><p>Every hourly health check saves the reason whenever a pending row should have moved to posted but didn't, including rows you've since fixed by hand. Kept 30 days after they're resolved.</p></div><button class="btn" data-click="loadStuck">Refresh</button></div>
      <div id="stuckOut"></div>
      <div class="recovery"><div><strong>What YNAB has</strong><p>The YNAB register for the selected account (30 days), with worker ownership flags.</p></div><button class="btn" data-click="showYnabRegister">Show</button></div>
      <div class="recovery"><div><strong>Encrypt bank tokens</strong><p>Encrypts every stored bank token with your TOKEN_ENCRYPTION_KEY secret (or re-encrypts after you rotate it). Needed once after adding the key.</p></div><button class="btn" data-click="show" data-path="/accounts/encrypt-tokens" data-method="POST">Encrypt</button></div>
      <div class="recovery"><div><strong>Re-register webhooks</strong><p>Points every bank login's Plaid webhook at this worker.</p></div><button class="btn" data-click="show" data-path="/configure-webhooks" data-method="POST">Configure</button></div>
      <div class="recovery"><div><strong>Test alert email</strong><p>Sends a fake "needs reconnect" email to confirm alerts work.</p></div><button class="btn" data-click="show" data-path="/test-alert" data-method="POST">Send test</button></div>
      <div class="recovery"><div><strong>Live logs</strong><p>From your PC: <code>npx wrangler tail</code> in the project folder.</p></div></div>
    </div>
    <div class="block">
      <h2>Raw output</h2>
      <pre id="output">No output yet.</pre>
    </div>
  </section>
</main>

<script nonce="${nonce}">
// Browser-side helpers. The server-side escapeHtml/safeCssClass imports don't exist in
// the page, so the page script needs its own copies (same behavior as src/util/html.ts).
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function safeCssClass(v, allowed) { return typeof v === "string" && allowed.indexOf(v) >= 0 ? v : ""; }
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

var writesInFlight = 0;
async function api(path, opts, raw) {
  var writes = !!(opts && opts.method && opts.method !== "GET");
  var resp, text;
  if (writes) writesInFlight++;
  try {
    resp = await fetch(path, Object.assign({}, opts || {}, { credentials: "same-origin", headers: Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {}) }));
    text = await resp.text();
  } catch (e) {
    // No answer is not the same as "it failed": a change may have gone through and
    // only the reply was lost. Say so, instead of a bare "Failed to fetch".
    throw new Error(writes
      ? "The connection dropped before the worker answered, so this may or may not have gone through. Reload the page to see the current state before trying again."
      : "Couldn't reach the worker (" + e.message + "). Check your connection and try again.");
  } finally { if (writes) writesInFlight--; }
  var data; try { data = JSON.parse(text); } catch (e) { data = text; }
  // Raw output only shows what you asked to see (Recovery actions and your own
  // actions), not the dashboard's background refreshes.
  if (raw !== false) $("output").textContent = when(new Date().toISOString()) + "  " + path + String.fromCharCode(10) + (typeof data === "string" ? data : JSON.stringify(data, null, 2));
  if (resp.status === 401) { sessionEnded(); throw new Error("Signed out: your admin session has ended. Enter the admin token under Settings, then try again. Nothing was changed."); }
  if (resp.status === 409 && data && data.busy) throw new Error(data.error);
  if (!resp.ok) { var err = new Error((data && data.error) || ("HTTP " + resp.status)); err.stale = !!(data && data.stale); throw err; }
  return data;
}
function quiet(path) { return api(path, undefined, false); }
// Sessions last an hour. When one ends (or is signed out elsewhere), say so once and
// open Settings at the token box, instead of every panel failing with "unauthorized".
var sessionTimer = null, sessionEndedShown = false;
function sessionEnded() {
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  if (sessionEndedShown) return;
  sessionEndedShown = true;
  setOverall("Signed out", "");
  attention(["Your admin session has ended (sessions last an hour). Enter the admin token under Settings to continue. Nothing was changed."], "warn");
  openTab("settings");
  try { $("token").focus(); } catch (e) { /* not focusable yet */ }
}
// Five minutes before the session ends, say so, so a long edit isn't lost to a 401.
function trackSession(expiresAt) {
  sessionEndedShown = false;
  if (sessionTimer) clearTimeout(sessionTimer);
  var ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
  if (!isFinite(ms)) return;
  sessionTimer = setTimeout(function () {
    attention(["Your admin session ends in about 5 minutes. Save what you're editing, then enter the admin token under Settings to stay signed in."], "warn");
    sessionTimer = setTimeout(sessionEnded, 5 * 60 * 1000);
  }, Math.max(0, ms - 5 * 60 * 1000));
}
// Raw-output helper. Actions that change something (webhooks, refresh, test alert) are
// POST-only on the server, so pass "POST" for those; read-only debug views stay GET.
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
  if (!items || !items.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.className = "flash" + (level === "bad" ? " bad" : level === "warn" ? " warn" : "");
  el.innerHTML = "<ul>" + items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
  flashTimer = setTimeout(function () { el.style.display = "none"; }, 120000);
}
// Backwards-compatible name used by the rules/settings code for action results.
function attention(items, level) { flash(items, level === "ok" ? "ok" : level); }

// The status banner: exactly what the server says needs attention.
function renderBanner(list) {
  var el = $("attention");
  if (!list || !list.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  var bad = list.some(function (x) { return x.level === "bad"; });
  el.style.display = "";
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
  if (explained > 0.01) diffNotes.push("plus " + money(explained) + " in known differences (listed under each account; they clear on their own)");
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
  import_gave_up: "Needs you: not imported", marked_cleared: "Your entry cleared (posted at bank)", too_old_to_import: "Needs you: too old to import", transaction_quarantined: "Needs you: unreadable bank item", stuck_pending: "Needs you: pending row stuck", cursor_rebuilt: "Bank history replayed",
  matched_existing_row: "Already in YNAB (linked to your row)",
  matched_by_amount_only: "Check: linked to your row by amount only"
};
var NEEDS_YOU = { update_failed: 1, delete_failed: 1, import_gave_up: 1, too_old_to_import: 1, stuck_pending: 1, transaction_quarantined: 1 };
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
  $("previewBlock").style.display = "";
  $("preview").innerHTML = rows.length ? '<div class="card scroll"><table class="table"><tr><th>Account</th><th>Action</th><th>Date</th><th>Payee</th><th class="num">Amount</th></tr>' + rows.join("") + "</table></div>" : '<div class="empty">Nothing to do. YNAB already matches the bank.</div>';
  openTab("activity");
}

// ---------- Actions ----------
function acctQuery(prefix) { return selected() ? prefix + "account=" + encodeURIComponent(selected()) : ""; }

// How fresh the bank data behind a sync was, from the last connection check.
function feedAge(nickname) {
  var it = state.items && state.items[nickname];
  return it && it.last_bank_update ? " (bank data from " + ago(it.last_bank_update) + ")" : "";
}
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
    var line = name + ": " + (c + u + x ? [c ? c + " added" : "", u ? u + " updated" : "", x ? x + " removed" : ""].filter(Boolean).join(", ") : "already matches the bank feed" + feedAge(r.account));
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
      $("previewBlock").style.display = "none";
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
    $("audit").style.opacity = ".5";
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
    finally { $("audit").style.opacity = ""; }
  });
}
async function undo(btn) {
  await busy(btn, async function () {
    try {
      var list = await api("/undo?list=true");
      if (!list.runs || !list.runs.length) { flash(["Nothing to undo."], "warn"); return; }
      var menu = list.runs.map(function (r) { return r.index + ": " + when(r.ts) + " · " + r.trigger + " · " + r.count + " row(s) added"; }).join(String.fromCharCode(10));
      var pick = prompt("Remove the rows which sync added? Enter its number:" + String.fromCharCode(10) + menu, "0");
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
      if (!list.length) { $("stuckOut").innerHTML = '<p class="small" style="margin:6px 0 12px">No stuck pending rows recorded.</p>'; return; }
      $("stuckOut").innerHTML = '<div class="card scroll" style="margin:8px 0 14px"><table class="table"><tr><th>Account</th><th>Row</th><th class="num">Amount</th><th>What Plaid said</th><th>Status</th></tr>' +
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
      var head = '<p class="small" style="padding:10px 14px 0;margin:0"><strong>' + esc(pretty(a)) + ':</strong> Plaid currently lists <strong>' + d.plaid_pending_count + '</strong> pending charge(s); YNAB has <strong>' + d.ynab_uncleared_worker_rows + '</strong> pending row(s) from the worker. Plaid last got data from the bank: ' + esc(d.plaid_last_bank_update ? when(d.plaid_last_bank_update) + " (" + ago(d.plaid_last_bank_update) + ")" : "unknown") + (d.window_truncated ? " · bank data truncated" : "") + "</p>";
      var rows = (d.rows || []).map(function (r) {
        var looks = (r.unlinked_posted_lookalikes || []).map(function (c) { return c.name + " " + money(c.amount) + " on " + c.date; }).join("; ");
        return "<tr><td>" + esc(r.date) + "</td><td>" + esc(r.payee) + '</td><td class="num">' + money(r.amount) + "</td><td>" + esc(r.verdict) + (looks ? '<br><span class="small">Posted look-alikes: ' + esc(looks) + "</span>" : "") + "</td></tr>";
      }).join("");
      $("traceOut").innerHTML = '<div class="card scroll" style="margin:8px 0 14px">' + head + (rows ? '<table class="table"><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th>What Plaid says about it</th></tr>' + rows + "</table>" : '<p class="small" style="padding:0 14px 10px">No pending rows from the worker.</p>') + "</div>";
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
var reconSeq = 0;
async function runReconcile(btn) {
  await busy(btn, async function () {
  var seq = ++reconSeq;
  $("recon").innerHTML = '<div class="empty">Comparing…</div>';
  try {
    var q = "?days=" + $("reconDays").value + (selected() ? "&account=" + encodeURIComponent(selected()) : "");
    var d = await api("/reconcile" + q);
    // The account choice changed while this was loading: these results are for the
    // old choice, so don't show them under the new one.
    if (seq !== reconSeq) return;
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
// ---------- List editors (skip rules, payee aliases, transfer labels) ----------
// Each list is saved whole. The page keeps the copy it last loaded or saved
// (state.saved) and its version, so:
// - deleting one entry saves the saved copy minus that entry, never your other,
//   unsaved edits (deleting used to save every half-typed change on the page);
// - a save made from a page that is out of date is refused instead of overwriting
//   a change made in another tab or on another device;
// - coming back to the Rules tab keeps unsaved edits instead of silently reloading.
var EDITORS = {
  rules: { path: "/skip-rules", field: "rules", noun: "rule", cap: "Rule", label: "Skip rules", render: function () { renderRules(); },
    name: function (r) { return r.contains; },
    invalid: function (r) { return String(r.contains || "").trim() ? "" : "needs Bank text contains"; } },
  aliases: { path: "/payee-aliases", field: "aliases", noun: "alias group", cap: "Alias group", label: "Aliases", render: function () { renderAliases(); },
    name: function (g) { return g.canonical; },
    invalid: function (g) { return String(g.canonical || "").trim() && (g.patterns || []).length ? "" : "needs a merchant and at least one name"; } },
  tlabels: { path: "/transfer-labels", field: "labels", noun: "transfer label", cap: "Transfer label", label: "Transfer labels", render: function () { renderTLabels(); },
    name: function (l) { return l.label || l.tail; },
    invalid: function (l) { return String(l.tail || "").replace(/[^0-9]/g, "").length >= 3 && String(l.label || "").trim() ? "" : "needs at least 3 digits and a payee name"; } }
};
state.saved = { rules: [], aliases: [], tlabels: [] }; state.versions = {};
function adoptList(kind, list, version) {
  state.saved[kind] = JSON.parse(JSON.stringify(list || []));
  state.versions[kind] = version;
  // _k: the entry's position in the saved list (absent for an entry not saved yet).
  // Not enumerable, so it never goes to the server.
  state[kind] = (list || []).map(function (x, i) { Object.defineProperty(x, "_k", { value: i, writable: true, enumerable: false }); return x; });
}
function listDirty(kind) { return JSON.stringify(state[kind] || []) !== JSON.stringify(state.saved[kind] || []); }
async function loadList(kind, force) {
  var E = EDITORS[kind];
  if (!force && listDirty(kind)) { E.render(); return; }
  try { var d = await quiet(E.path); adoptList(kind, d[E.field], d.version); E.render(); } catch (e) { attention([e.message], "bad"); }
}
async function saveList(kind, btn) {
  var E = EDITORS[kind], bad = [];
  state[kind].forEach(function (x, i) { var why = E.invalid(x); if (why) bad.push(E.cap + " " + (i + 1) + " " + why + "."); });
  // An incomplete entry used to be dropped silently while the page said "saved".
  if (bad.length) { attention(bad.concat(["Nothing was saved. Fill these in or delete them, then save again."]), "bad"); return; }
  await busy(btn, async function () {
    try {
      var body = { expected_version: state.versions[kind] }; body[E.field] = state[kind];
      var d = await api(E.path, { method: "POST", body: JSON.stringify(body) });
      adoptList(kind, d[E.field], d.version); E.render(); attention([E.label + " saved."], "ok");
    } catch (e) { attention(e.stale ? [e.message, "The latest saved version is shown now."] : [e.message], "bad"); if (e.stale) loadList(kind, true); }
  });
}
async function deleteFromList(kind, i, btn) {
  var E = EDITORS[kind], item = state[kind][i];
  if (!item) return;
  var savedEntry = item._k != null;
  if (!confirm("Delete the " + E.noun + (E.name(item) ? ' "' + E.name(item) + '"' : "") + "?" + (savedEntry ? " This is saved immediately. Unsaved edits to the others are not saved." : ""))) return;
  if (!savedEntry) { state[kind].splice(i, 1); E.render(); return; }
  await busy(btn, async function () {
    try {
      var k = item._k;
      var body = { expected_version: state.versions[kind] };
      body[E.field] = state.saved[kind].filter(function (_, j) { return j !== k; });
      var d = await api(E.path, { method: "POST", body: JSON.stringify(body) });
      state[kind] = state[kind].filter(function (x) { return x !== item; });
      state[kind].forEach(function (x) { if (x._k != null && x._k > k) x._k--; });
      state.saved[kind] = JSON.parse(JSON.stringify(d[E.field] || [])); state.versions[kind] = d.version;
      E.render(); attention([E.cap + " deleted."], "ok");
    } catch (e) { attention(e.stale ? [e.message, "The latest saved version is shown now."] : [e.message], "bad"); if (e.stale) loadList(kind, true); }
  });
}
function loadRules() { return loadList("rules"); }
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
      '</div><div class="actions"><button class="btn ghost" data-click="deleteRule" data-arg="' + i + '">Delete rule</button></div></div>';
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
function addRule() { state.rules.push({ id: "rule-" + Date.now(), enabled: true, account: state.accounts[0] || "*", contains: "", transaction_type: "inflow", reason: "Entered manually in YNAB" }); renderRules(); }
async function resetRules() {
  if (!confirm("Replace your rules with the built-in defaults?")) return;
  try { state.rules = (await api("/skip-rules/reset", { method: "POST" })).rules; renderRules(); } catch (e) { attention([e.message], "bad"); }
}
function loadAliases() { return loadList("aliases"); }
function renderAliases() {
  $("aliases").innerHTML = state.aliases.length ? state.aliases.map(function (g, i) {
    return '<div class="card item"><div class="grid2"><div><span class="field-label">Merchant</span><input aria-label="Merchant" data-a="' + i + '" data-f="canonical" value="' + esc(g.canonical) + '" /></div>' +
      '<div><span class="field-label">Names that mean it (comma-separated)</span><input aria-label="Names that mean it (comma-separated)" data-a="' + i + '" data-f="patterns" value="' + esc((g.patterns || []).join(", ")) + '" /></div></div>' +
      '<div class="actions"><button class="btn ghost" data-click="deleteAlias" data-arg="' + i + '">Remove group</button></div></div>';
  }).join("") : '<div class="empty">No aliases.</div>';
  $("aliases").querySelectorAll("[data-a]").forEach(function (el) {
    el.addEventListener("input", function () {
      var g = state.aliases[Number(el.getAttribute("data-a"))], f = el.getAttribute("data-f");
      g[f] = f === "patterns" ? el.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : el.value;
    });
  });
}
function addAlias() { state.aliases.push({ canonical: "", patterns: [] }); renderAliases(); }

function loadTLabels() { return loadList("tlabels"); }
function renderTLabels() {
  $("tlabels").innerHTML = state.tlabels.length ? state.tlabels.map(function (l, i) {
    return '<div class="card item"><div class="grid2"><div><span class="field-label">Last digits</span><input aria-label="Last digits" inputmode="numeric" data-t="' + i + '" data-f="tail" value="' + esc(l.tail) + '" /></div>' +
      '<div><span class="field-label">Payee name</span><input aria-label="Payee name" data-t="' + i + '" data-f="label" value="' + esc(l.label) + '" /></div></div>' +
      '<div class="actions"><button class="btn ghost" data-click="deleteTLabel" data-arg="' + i + '">Remove</button></div></div>';
  }).join("") : '<div class="empty">No labels.</div>';
  $("tlabels").querySelectorAll("[data-t]").forEach(function (el) {
    el.addEventListener("input", function () { state.tlabels[Number(el.getAttribute("data-t"))][el.getAttribute("data-f")] = el.value; });
  });
}
function addTLabel() { state.tlabels.push({ tail: "", label: "" }); renderTLabels(); }

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
async function toggleGlobal(btn) {
  var on = $("globalBtn").getAttribute("data-on") === "1";
  if (on && !confirm("Pause all syncing? Nothing imports until you resume.")) return;
  var result = null;
  // /pause and /resume are POST-only on the server (this used to send a GET, so the
  // button always failed with "POST only").
  await busy(btn, async function () {
    try { await api(on ? "/pause" : "/resume", { method: "POST" }); result = [[on ? "Syncing paused. Nothing imports until you resume." : "Syncing resumed."], on ? "warn" : "ok"]; }
    catch (e) { result = [[e.message], "bad"]; }
  });
  // After busy() has put the button back, show what the server now says.
  await refreshGlobal(); loadAll();
  if (result) attention(result[0], result[1]);
}
async function saveToken() {
  var v = $("token").value.trim(); if (!v) return;
  try {
    var resp = await fetch("/session", { method: "POST", credentials: "same-origin", headers: { "x-admin-token": v } });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Authentication failed.");
    $("token").value = "";
    trackSession(data.expires_at);
    await loadAll(); loadItems(false);
    attention(["Authenticated. The admin token is held in an HttpOnly browser cookie, not Web Storage."], "ok");
  } catch (e) { attention([e.message], "bad"); }
}
async function clearToken() {
  var d = {};
  try { d = await (await fetch("/session", { method: "DELETE", credentials: "same-origin" })).json(); } catch (e) { /* cookie is cleared regardless */ }
  setOverall("No token", "");
  attention([d && d.signed_out_everywhere ? "Signed out on every browser. Any other open dashboard needs the admin token again." : "This browser's admin session was cleared."], "ok");
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

async function loadAccounts(force) {
  // Coming back to Settings keeps edits you haven't saved (it used to reload and
  // drop them without a word).
  if (state.acctDirty && !force) return;
  try {
    var a, s, tries = 0;
    // Two reads; if something was saved in between, read again so the version
    // sent back with "Save accounts" matches what is on screen.
    do { s = await quiet("/account-settings"); a = await quiet("/accounts"); } while (s.config_version !== a.config_version && ++tries < 3);
    state.acctVersion = s.config_version === a.config_version ? a.config_version : undefined;
    state.acctDirty = false;
    state.acctRows = a.accounts || [];
    state.settings = s.settings || [];
    $("accounts").innerHTML = state.acctRows.map(function (r, i) {
      var st = state.settings.find(function (x) { return x.nickname === r.nickname; }) || {};
      var freq = [15, 30, 60, 120, 240].map(function (m) { return '<option value="' + m + '"' + (st.sync_frequency_minutes === m ? " selected" : "") + ">Every " + (m < 60 ? m + " min" : (m / 60) + " hr") + "</option>"; }).join("");
      return '<div class="card item" data-acct="' + i + '"><h3>' + esc(pretty(r.nickname)) + ' <span class="small">' + esc(r.institution || "") + (r.has_token ? " · token " + esc(r.token_preview) : " · no token") + "</span></h3><div class='grid2'>" +
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
async function saveAccounts(btn) {
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
  await busy(btn, async function () {
    try {
      // expected_version: refuse to save over a change made elsewhere since this page
      // loaded (a stale page used to drop a just-added account, or turn back on an
      // account switched off on another device).
      await api("/accounts/save", { method: "POST", body: JSON.stringify({ accounts: accounts, settings: settings, expected_version: state.acctVersion }) });
      attention(["Accounts saved. Changes apply on the next sync."], "ok");
      state.acctDirty = false; loadAccounts(true); loadAll();
    } catch (e) {
      attention(e.stale ? [e.message, "The latest saved settings are shown now."] : [e.message], "bad");
      if (e.stale) { state.acctDirty = false; loadAccounts(true); }
    }
  });
}
$("accounts").addEventListener("input", function () { state.acctDirty = true; });
$("accounts").addEventListener("change", function () { state.acctDirty = true; });
// Leaving the page with unsaved edits, or while a change is still being sent, asks first.
window.addEventListener("beforeunload", function (ev) {
  if (writesInFlight > 0 || state.acctDirty || ["rules", "aliases", "tlabels"].some(listDirty)) { ev.preventDefault(); ev.returnValue = ""; }
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
  $("accountSelect").addEventListener("change", function () {
    loadEvents(); $("traceOut").innerHTML = "";
    // The dry-run preview and reconcile results were for the previous choice.
    reconSeq++; $("recon").innerHTML = ""; $("previewBlock").style.display = "none";
  });
  updateDryNote();
  if (hashToken) {
    $("token").value = hashToken;
    await saveToken();
    return;
  }
  try {
    var sess = await api("/session", undefined, false);
    trackSession(sess && sess.expires_at);
    loadAll();
    loadItems(false);
  } catch (e) {
    sessionEndedShown = false;
    setOverall("No token", "");
    attention(["Add your admin token under Settings."], "warn");
    openTab("settings");
  }
})();

// Buttons say what they do with data-click (and data-path / data-method / data-arg),
// and this one listener runs it from a fixed list. No inline handlers, so the page
// can run under a CSP that allows only its own nonce-tagged script.
var CLICK = {
  runSync: function (el) { runSync(el); }, recheck: function (el) { recheck(el); }, rescan: function (el) { rescan(el); },
  runReconcile: function (el) { runReconcile(el); }, undo: function (el) { undo(el); },
  tracePending: function (el) { tracePending(el); }, loadStuck: function (el) { loadStuck(el); },
  addRule: function () { addRule(); }, saveRules: function (el) { saveList("rules", el); },
  addAlias: function () { addAlias(); }, saveAliases: function (el) { saveList("aliases", el); },
  addTLabel: function () { addTLabel(); }, saveTLabels: function (el) { saveList("tlabels", el); },
  toggleGlobal: function (el) { toggleGlobal(el); }, saveToken: function () { saveToken(); }, clearToken: function () { clearToken(); },
  saveAccounts: function (el) { saveAccounts(el); }, loadItemsFresh: function () { loadItems(true); },
  show: function (el) { show(el.getAttribute("data-path"), el, el.getAttribute("data-method") || undefined); },
  showPlaidRaw: function () { needAccount(function (a) { show("/debug/plaid/raw?account=" + a + "&days=30&count=100"); }); },
  showYnabRegister: function () { needAccount(function (a) { show("/debug/ynab-register?account=" + a + "&days=30"); }); },
  deleteRule: function (el, arg) { deleteFromList("rules", Number(arg), el); }, deleteAlias: function (el, arg) { deleteFromList("aliases", Number(arg), el); },
  deleteTLabel: function (el, arg) { deleteFromList("tlabels", Number(arg), el); }
};
document.addEventListener("click", function (ev) {
  var el = ev.target && ev.target.closest ? ev.target.closest("[data-click]") : null;
  if (!el || el.disabled) return;
  var fn = CLICK[el.getAttribute("data-click")];
  if (fn) fn(el, el.getAttribute("data-arg"));
});
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...pageSecurityHeaders(nonce) }
  });
}
