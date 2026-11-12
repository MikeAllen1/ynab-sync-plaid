import { escapeHtml as esc } from "../util/html";

// ---------- Dashboard ----------

export function setupHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bank connections · YNAB Sync</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    :root { --bg:#f7f8fb; --surface:#fff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --control-border:#7b8494; --primary:#2563eb; --link:#1d4ed8; --ok-bg:#ecfdf5; --ok:#065f46; --bad-bg:#fef2f2; --bad:#991b1b; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0b1020; --surface:#121a2b; --text:#e5e9f2; --muted:#93a0b8; --border:#243049; --control-border:#6b7a96; --primary:#2563eb; --link:#9dc0ff; --ok-bg:#0f2a1c; --ok:#7ee2a8; --bad-bg:#2e1215; --bad:#ffa3a3; } }
    a { color: var(--link); }
    * { box-sizing: border-box; }
    body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 32px 16px; color: var(--text); background: var(--bg); }
    h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 6px; }
    .muted { color: var(--muted); font-size: 14px; }
    input, select { width: 100%; padding: 9px 10px; font: inherit; border: 1px solid var(--control-border); border-radius: 8px; background: var(--surface); color: var(--text); }
    .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }
    .row .name { flex: 1; font-weight: 600; }
    button { padding: 9px 16px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--primary); color: #fff; cursor: pointer; }
    button[disabled] { opacity: .5; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-top: 10px; display: grid; gap: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
    #status { margin-top: 16px; padding: 12px; border-radius: 8px; display: none; }
    #status.ok { display: block; background: var(--ok-bg); color: var(--ok); }
    #status.err { display: block; background: var(--bad-bg); color: var(--bad); }
  </style>
</head>
<body>
  <p class="muted"><a href="/dashboard">← Back to the dashboard</a></p>
  <h1>Bank connections</h1>
  <p class="muted">Reconnect a bank that says "Needs reauth", or add a new one. Nothing here changes existing transactions.</p>
  <p class="muted"><label for="token"><strong>Admin token</strong> (used once to establish a one-hour browser session)</label></p>
  <input id="token" type="password" placeholder="Admin token" autocomplete="off" />

  <h2>Reconnect</h2>
  <p class="muted">Repairs the existing connection in place: same accounts, same history. Chase asks for this every few months.</p>
  <div id="banks"></div>

  <h2>Add a bank</h2>
  <p class="muted">Link the bank, then choose which of its accounts to sync and the YNAB account each one feeds. Before the first sync, set the YNAB account's starting balance to the bank's posted balance.</p>
  <button id="addBtn">Link a new bank</button>
  <div id="newAccounts"></div>
  <div id="status"></div>

<script>
var tokenInput = document.getElementById("token");
sessionStorage.removeItem("ynab_sync_admin_token");
var authentication = null;
tokenInput.addEventListener("change", function () { authenticate().catch(function () {}); });
 document.getElementById("addBtn").addEventListener("click", addBank);
 document.getElementById("newAccounts").addEventListener("click", function (event) { var button = event.target && event.target.closest ? event.target.closest('[data-action="add-account"]') : null; if (button) addAccount(button); });
async function authenticate() {
  if (authentication) return authentication;
  var value = tokenInput.value.trim();
  if (!value) return;
  authentication = (async function () {
    var response = await fetch("/session", { method: "POST", credentials: "same-origin", headers: { "x-admin-token": value } });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || "Authentication failed.");
    tokenInput.value = "";
    setStatus("Authenticated. The admin token is held in an HttpOnly cookie, not Web Storage.", true);
    loadBanks();
  })();
  try { await authentication; }
  catch (e) { setStatus(e.message, false); throw e; }
  finally { authentication = null; }
}

function setStatus(msg, ok) { var s = document.getElementById("status"); s.textContent = msg; s.className = ok ? "ok" : "err"; }
async function post(path, body) {
  if (tokenInput.value.trim()) await authenticate();
  var response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return response.json();
}
async function get(path) {
  if (tokenInput.value.trim()) await authenticate();
  var response = await fetch(path, { credentials: "same-origin" });
  return response.json();
}

function openLink(linkToken, receivedRedirectUri, onSuccess) {
  var config = {
    token: linkToken,
    onSuccess: onSuccess,
    onExit: function (err) { if (err) setStatus("Link closed: " + (err.error_message || err.error_code || "cancelled"), false); document.getElementById("addBtn").disabled = false; }
  };
  if (receivedRedirectUri) config.receivedRedirectUri = receivedRedirectUri;
  Plaid.create(config).open();
}

function reconnect(nickname) {
  setStatus("Starting a secure reconnect for " + nickname + "…", true);
  post("/link-token", { nickname: nickname }).then(function (d) {
    if (!d.ok) { setStatus("Could not start: " + (d.error || "unknown"), false); return; }
    sessionStorage.setItem("link_token", d.link_token);
    sessionStorage.setItem("link_mode", "update");
    sessionStorage.setItem("link_nickname", nickname);
    openLink(d.link_token, null, onReconnected);
  }).catch(function (e) { setStatus("Network error: " + e.message, false); });
}
function onReconnected() {
  sessionStorage.removeItem("link_token");
  setStatus("Reconnected. Re-checking the connection…", true);
  var nick = sessionStorage.getItem("link_nickname") || "";
  post("/reconnected", { nickname: nick }).then(function (d) {
    setStatus(d && d.ok ? "Reconnected, and the connection now checks out. The next sync uses it." : "Reconnected. The next sync uses the repaired connection.", true);
  }).catch(function () { setStatus("Reconnected. The next sync uses the repaired connection.", true); });
}

function addBank() {
  document.getElementById("addBtn").disabled = true;
  setStatus("Starting a secure link…", true);
  post("/link-token", {}).then(function (d) {
    if (!d.ok) { setStatus("Could not start: " + (d.error || "unknown"), false); document.getElementById("addBtn").disabled = false; return; }
    sessionStorage.setItem("link_token", d.link_token);
    sessionStorage.setItem("link_mode", "create");
    openLink(d.link_token, null, onLinked);
  }).catch(function (e) { setStatus("Network error: " + e.message, false); document.getElementById("addBtn").disabled = false; });
}
function onLinked(publicToken, metadata) {
  sessionStorage.removeItem("link_token");
  setStatus("Linked. Loading its accounts…", true);
  Promise.all([post("/exchange-token", { public_token: publicToken }), get("/ynab-accounts")]).then(function (res) {
    var ex = res[0], ynab = res[1];
    if (!ex.ok) { setStatus("Link failed: " + (ex.error || "unknown"), false); return; }
    var institution = (metadata && metadata.institution && metadata.institution.name) || "";
    var options = (ynab.accounts || []).map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + "</option>"; }).join("");
    document.getElementById("newAccounts").innerHTML = (ex.accounts || []).map(function (a) {
      var isCard = a.type === "credit";
      return '<div class="card" data-plaid="' + esc(a.account_id) + '" data-link="' + esc(ex.link_id) + '" data-institution="' + esc(institution) + '" data-mask="' + esc(a.mask || "") + '"><strong>' + esc(a.name) + " ····" + esc(a.mask || "") + " <span class='muted'>(" + esc(a.subtype || a.type) + ")</span></strong>" +
        '<div class="grid"><input data-f="nickname" placeholder="Nickname, e.g. amex" />' +
        '<select data-f="ynab"><option value="">Choose YNAB account…</option>' + options + "</select></div>" +
        '<label class="muted"><input type="checkbox" data-f="card" style="width:auto"' + (isCard ? " checked" : "") + " /> Credit card</label>" +
        '<button data-action="add-account">Add this account</button></div>';
    }).join("");
    setStatus("Choose the accounts to sync. Each one starts syncing on the next run.", true);
    document.getElementById("addBtn").disabled = false;
  }).catch(function (e) { setStatus("Error: " + e.message, false); document.getElementById("addBtn").disabled = false; });
}
// Values come from data- attributes (read back as plain strings), not from inline
// JavaScript, so a bank name with an apostrophe can't break the button.
function addAccount(btn) {
  var card = btn.closest(".card");
  var body = {
    link_id: card.getAttribute("data-link"), institution: card.getAttribute("data-institution"),
    mask: card.getAttribute("data-mask"),
    plaid_account_id: card.getAttribute("data-plaid"),
    nickname: card.querySelector('[data-f="nickname"]').value.trim(),
    ynab_account_id: card.querySelector('[data-f="ynab"]').value,
    is_credit_card: card.querySelector('[data-f="card"]').checked
  };
  if (!body.nickname || !body.ynab_account_id) { setStatus("Give it a nickname and choose its YNAB account.", false); return; }
  btn.disabled = true;
  post("/accounts/add", body).then(function (d) {
    if (!d.ok) { setStatus(d.error || "Could not add", false); btn.disabled = false; return; }
    btn.textContent = "Added"; setStatus(d.note, true); loadBanks();
  }).catch(function (e) { setStatus("Network error, the account was not added: " + e.message, false); btn.disabled = false; });
}

function prettyName(n) { return String(n || "").split("-").map(function (w) { return w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1); }).join(" "); }
function loadBanks() {
  get("/debug/account-map").then(function (accts) {
    var wrap = document.getElementById("banks");
    if (!Array.isArray(accts)) { wrap.innerHTML = '<p class="muted">Enter your admin token above.</p>'; return; }
    wrap.innerHTML = "";
    // One Reconnect per bank login: a checking account and a card at the same bank share one login.
    var logins = {}, order = [];
    accts.forEach(function (a) { var k = a.login || a.nickname; if (!logins[k]) { logins[k] = []; order.push(k); } logins[k].push(a); });
    if (!order.length) { wrap.innerHTML = '<p class="muted">No banks yet. Add one below.</p>'; return; }
    order.forEach(function (k) {
      var group = logins[k];
      var row = document.createElement("div"); row.className = "row";
      var label = (group[0].institution ? group[0].institution + ": " : "") + group.map(function (a) { return prettyName(a.nickname); }).join(", ");
      row.innerHTML = '<span class="name">' + esc(label) + "</span>";
      var b = document.createElement("button"); b.textContent = "Reconnect";
      b.setAttribute("aria-label", "Reconnect " + label);
      b.onclick = function () { reconnect(group[0].nickname); };
      row.appendChild(b); wrap.appendChild(row);
    });
  }).catch(function () { document.getElementById("banks").innerHTML = '<p class="muted">Enter your admin token above.</p>'; });
}

// OAuth return (Chase): resume Link with the stored token.
(function () {
  if (location.search.indexOf("oauth_state_id=") !== -1) {
    var t = sessionStorage.getItem("link_token");
    if (t) openLink(t, location.href, sessionStorage.getItem("link_mode") === "create" ? onLinked : onReconnected);
  }
})();
get("/session").then(function (d) { if (d && d.ok) loadBanks(); }).catch(function () {});
</script>
</body>
</html>`;
}
