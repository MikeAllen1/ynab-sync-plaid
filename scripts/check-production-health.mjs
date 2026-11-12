const baseUrl = process.env.WORKER_BASE_URL;
const adminToken = process.env.ADMIN_TOKEN;

if (!baseUrl || !adminToken) {
  throw new Error("WORKER_BASE_URL and ADMIN_TOKEN GitHub Actions secrets must be configured.");
}

const workerUrl = new URL(baseUrl);
if (workerUrl.protocol !== "https:") {
  throw new Error("WORKER_BASE_URL must use HTTPS.");
}
const origin = workerUrl.origin;

const sessionResponse = await fetch(new URL("/session", origin), {
  method: "POST",
  headers: {
    Origin: origin,
    "x-admin-token": adminToken
  },
  signal: AbortSignal.timeout(15_000)
});
if (!sessionResponse.ok) {
  throw new Error(`Production health monitor could not establish an admin session (HTTP ${sessionResponse.status}).`);
}

const setCookie = sessionResponse.headers.get("set-cookie");
const cookie = setCookie?.split(";")[0];
if (!cookie || !cookie.startsWith("__Host-ynab_admin=")) {
  throw new Error("Production health monitor did not receive the expected secure admin session cookie.");
}

const healthResponse = await fetch(new URL("/health", origin), {
  headers: { Cookie: cookie },
  signal: AbortSignal.timeout(15_000),
  cache: "no-store"
});
if (!healthResponse.ok) {
  throw new Error(`Production health endpoint returned HTTP ${healthResponse.status}.`);
}

let health;
try {
  health = await healthResponse.json();
} catch {
  throw new Error("Production health endpoint returned invalid JSON.");
}

const failures = [];
if (health?.ok !== true) failures.push("health endpoint ok flag is false");
if (health?.health_status !== "healthy") failures.push(`health_status is ${String(health?.health_status ?? "missing")}`);
if (health?.sync_enabled !== true) failures.push("global synchronization is paused");
if (health?.lock_mode !== "durable-object") failures.push("Durable Object lock is not active");
if (!Array.isArray(health?.overdue_accounts)) failures.push("overdue_accounts is missing or invalid");
else if (health.overdue_accounts.length) failures.push(`overdue accounts: ${health.overdue_accounts.join(", ")}`);

if (failures.length) {
  // Do not dump the full health payload: it contains account and transaction diagnostics.
  throw new Error(`Production health check failed: ${failures.join("; ")}.`);
}

console.log("Production health check passed: sync enabled, healthy status, Durable Object lock active, no overdue accounts.");
