import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every route the server only accepts as POST must be called with method POST by the
// dashboard. (A GET to these returns 405 "POST only", which looks like a broken button.)
test("dashboard buttons use POST for every POST-only route", () => {
  const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/ui/dashboard-page.ts", import.meta.url), "utf8");
  const postOnly = new Set<string>();
  for (const m of server.matchAll(/url\.pathname === "([^"]+)"\)\s*\{\s*if \(req\.method !== "POST"\)/g)) postOnly.add(m[1]);
  assert.ok(postOnly.has("/configure-webhooks") && postOnly.has("/sync"), "route scan found the POST-only routes");

  const problems: string[] = [];
  for (const m of page.matchAll(/show\('([^'?]+)[^']*'[^)]*\)/g)) {
    if (postOnly.has(m[1]) && !/'POST'\)$/.test(m[0])) problems.push(m[0]);
  }
  for (const m of page.matchAll(/data-click="show" data-path="([^"?]+)[^"]*"(?: data-method="([A-Z]+)")?/g)) {
    if (postOnly.has(m[1]) && m[2] !== "POST") problems.push(m[0]);
  }
  for (const m of page.matchAll(/api\("([^"?]+)[^"]*"([^;]*)/g)) {
    if (postOnly.has(m[1]) && !/method:\s*"POST"/.test(m[2])) problems.push(m[0].slice(0, 80));
  }
  // Paths chosen at run time (api(on ? "/pause" : "/resume")) escaped the check above,
  // which is how the Pause button shipped sending GET. Check every quoted path inside
  // any api(...) statement.
  for (const m of page.matchAll(/api\(([^;]*)/g)) {
    for (const p of m[1].matchAll(/"(\/[a-z\-\/]+)/g)) {
      if (postOnly.has(p[1]) && !/method:\s*"POST"/.test(m[1])) problems.push(m[0].slice(0, 80));
    }
  }
  assert.deepEqual(problems, [], "dashboard calls a POST-only route without POST");
});
