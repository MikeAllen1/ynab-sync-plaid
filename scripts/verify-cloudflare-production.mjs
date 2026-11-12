#!/usr/bin/env node
/**
 * Read-only production configuration verification for the YNAB Sync Worker.
 *
 * Required environment:
 *   CLOUDFLARE_API_TOKEN  Read-only token with Workers Scripts Read permission
 *   CLOUDFLARE_ACCOUNT_ID Cloudflare account ID
 *   ADMIN_TOKEN           Existing Worker admin secret (used only for live readiness)
 *   WORKER_URL            Deployed Worker origin, e.g. https://ynab-sync.example.workers.dev
 *
 * Optional:
 *   WORKER_NAME           Defaults to "ynab-sync"
 *
 * This script never retrieves or prints secret values and makes no configuration
 * changes. It verifies Cloudflare's deployed metadata plus the live Worker routes.
 */
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const workerName = process.env.WORKER_NAME || "ynab-sync";
const workerUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN;
let parsedWorkerUrl;
try { parsedWorkerUrl = new URL(workerUrl); } catch {}

if (!accountId || !apiToken || !workerUrl || !adminToken) {
  console.error("Missing required environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, WORKER_URL, ADMIN_TOKEN");
  process.exit(2);
}
if (!parsedWorkerUrl || parsedWorkerUrl.protocol !== "https:" || parsedWorkerUrl.pathname !== "/" ||
    parsedWorkerUrl.search || parsedWorkerUrl.hash || parsedWorkerUrl.username || parsedWorkerUrl.password) {
  console.error("WORKER_URL must be an HTTPS origin only (no path, query, fragment, or embedded credentials).");
  process.exit(2);
}

const base = "https://api.cloudflare.com/client/v4";
const failures = [];
const pass = message => console.log("PASS  " + message);
const fail = message => { failures.push(message); console.error("FAIL  " + message); };

async function cf(path) {
  const response = await fetch(base + path, { headers: { Authorization: "Bearer " + apiToken } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) {
    const detail = (body.errors || []).map(e => e.message).filter(Boolean).join("; ");
    throw new Error("Cloudflare API " + response.status + (detail ? ": " + detail : ""));
  }
  return body.result;
}

async function live(path, options = {}) {
  return fetch(workerUrl + path, {
    ...options,
    redirect: "manual",
    headers: { ...(options.headers || {}), "x-admin-token": adminToken, "Cache-Control": "no-store" }
  });
}

try {
  const scriptPath = "/accounts/" + accountId + "/workers/scripts/" + encodeURIComponent(workerName);
  const [settings, secrets, namespaces, kvNamespaces, deployments, schedules, tokenStatus] = await Promise.all([
    cf(scriptPath + "/settings"),
    cf(scriptPath + "/secrets"),
    cf("/accounts/" + accountId + "/workers/durable_objects/namespaces?per_page=1000"),
    cf("/accounts/" + accountId + "/storage/kv/namespaces?per_page=1000"),
    cf(scriptPath + "/deployments"),
    cf(scriptPath + "/schedules"),
    (async () => {
      try { return await cf("/user/tokens/verify"); }
      catch { return await cf("/accounts/" + accountId + "/tokens/verify"); }
    })()
  ]);

  if (tokenStatus.status === "active") pass("Cloudflare verification token is active");
  else fail("Cloudflare verification token is not active");

  const bindings = settings.bindings || [];
  const vars = settings.vars || {};
  const plaidEnvBinding = bindings.find(b => b.name === "PLAID_ENV" && b.type === "plain_text");
  const plaidEnv = plaidEnvBinding?.text ?? (Array.isArray(vars) ? vars.find(v => v.name === "PLAID_ENV")?.value : vars.PLAID_ENV);
  if (plaidEnv === "production") pass("Worker PLAID_ENV is production");
  else fail("Worker PLAID_ENV is not set to production");
  const kv = bindings.find(b => b.name === "SYNC_STATE" && b.type === "kv_namespace");
  if (kv?.namespace_id && kvNamespaces.some(n => n.id === kv.namespace_id)) pass("SYNC_STATE KV binding points to an existing namespace");
  else fail("SYNC_STATE KV binding or namespace is missing");

  const lock = bindings.find(b => b.name === "SYNC_LOCK" && b.type === "durable_object_namespace");
  if (!lock?.namespace_id || lock.class_name !== "SyncLock") fail("SYNC_LOCK Durable Object binding/class is missing");
  else {
    const namespace = namespaces.find(n => n.id === lock.namespace_id && n.class === "SyncLock" && n.script === workerName);
    if (namespace && namespace.use_sqlite === true) pass("SYNC_LOCK is bound to the deployed SQLite-backed SyncLock namespace");
    else fail("SYNC_LOCK namespace is missing, attached to another script, or not SQLite-backed");
  }

  const secretNames = new Set((secrets || []).map(s => s.name));
  for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET", "YNAB_TOKEN", "ADMIN_TOKEN"]) {
    if (secretNames.has(name)) pass("Required secret binding exists: " + name);
    else fail("Required secret binding is missing: " + name);
  }

  const deployedVersions = Array.isArray(deployments) ? deployments : deployments?.deployments;
  if (Array.isArray(deployedVersions) && deployedVersions.length > 0) pass("Cloudflare reports at least one deployed Worker version");
  else fail("No Worker deployment version was returned");

  const cronSchedules = schedules?.schedules || [];
  if (cronSchedules.some(schedule => schedule.cron === "*/15 * * * *")) pass("Expected 15-minute production Cron Trigger is configured");
  else fail("Expected production Cron Trigger (*/15 * * * *) is missing");

  const dashboard = await live("/dashboard");
  const dashboardCsp = dashboard.headers.get("content-security-policy") || "";
  const dashboardHtml = await dashboard.text();
  if (dashboard.status === 200 && dashboardCsp.includes("script-src 'nonce-") && dashboardCsp.includes("script-src-attr 'none'") && !dashboardCsp.includes("unsafe-inline")) {
    pass("Live dashboard returns nonce-only scripts and no inline script/style attributes");
  } else fail("Live dashboard CSP is missing or permissive");

  const setup = await live("/setup");
  const setupCsp = setup.headers.get("content-security-policy") || "";
  const setupHtml = await setup.text();
  const setupConnectSrc = setupCsp.split(";").map(part => part.trim()).find(part => part.startsWith("connect-src ")) || "";
  const productionPlaidOriginAllowed = /(?:^|\s)https:\/\/production\.plaid\.com(?:\s|$)/.test(setupConnectSrc);
  if (setup.status === 200 && setupCsp.includes("script-src 'nonce-") && !setupCsp.includes("script-src-attr 'unsafe-inline'") && productionPlaidOriginAllowed) {
    pass("Live setup page returns nonce scripts and the production Plaid Link allowlist");
  } else fail("Live setup CSP is missing or incompatible with production Plaid Link");

  for (const [label, html] of [["dashboard", dashboardHtml], ["setup", setupHtml]]) {
    if (/\sonclick\s*=|\sonerror\s*=|\sstyle\s*=/.test(html)) fail("Live " + label + " contains inline event/style attributes");
    else pass("Live " + label + " has no inline event/style attributes");
  }

  const readiness = await live("/admin/security-readiness");
  const readinessBody = await readiness.json().catch(() => ({}));
  if (readiness.status === 200 && readinessBody.ok === true &&
      readinessBody.bindings?.SYNC_STATE === true &&
      readinessBody.bindings?.SYNC_LOCK === true &&
      readinessBody.durable_object?.class === "SyncLock" &&
      readinessBody.durable_object?.storage === "available" &&
      readinessBody.kv_readable === true) {
    pass("Live Worker can read KV and execute a transactional SyncLock storage probe");
  } else fail("Live Worker storage readiness failed (HTTP " + readiness.status + ")");

  void dashboardHtml;
  void setupHtml;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
  console.error("\nProduction verification failed: " + failures.length + " check(s).");
  process.exit(1);
}
console.log("\nProduction verification passed. No secrets were retrieved or displayed.");
