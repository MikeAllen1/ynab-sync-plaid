import { test } from "node:test";
import assert from "node:assert/strict";
import { runCache } from "../src/plaid/fetch";
import { ynabGetPlanCurrency } from "../src/ynab/client";

const env: any = {
  YNAB_BUDGET_ID: "plan-id",
  YNAB_TOKEN: "token",
  SYNC_LOCK: {
    idFromName: () => "global",
    get: () => ({ fetch: async () => Response.json({ reserved: true }) })
  }
};

test("YNAB plan currency is read from plan settings and cached per run", async () => {
  const original = globalThis.fetch;
  runCache.delete("ynab_plan_currency");
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://api.ynab.com/v1/plans/plan-id/settings");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
    return Response.json({ data: { settings: { currency_format: { iso_code: "USD" } } } });
  }) as typeof fetch;
  try {
    assert.equal(await ynabGetPlanCurrency(env), "USD");
    assert.equal(await ynabGetPlanCurrency(env), "USD");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    runCache.delete("ynab_plan_currency");
  }
});

test("YNAB plan currency fails closed when settings omit a valid ISO code", async () => {
  const original = globalThis.fetch;
  runCache.delete("ynab_plan_currency");
  globalThis.fetch = (async () => Response.json({ data: { settings: { currency_format: null } } })) as typeof fetch;
  try {
    await assert.rejects(ynabGetPlanCurrency(env), /no valid ISO currency code/);
  } finally {
    globalThis.fetch = original;
    runCache.delete("ynab_plan_currency");
  }
});
