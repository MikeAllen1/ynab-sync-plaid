import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prettyNickname } from "../src/health/status";

test("nicknames read as words: acronyms in capitals, ordinary short words not", () => {
  assert.equal(prettyNickname("car-loan"), "Car Loan");
  assert.equal(prettyNickname("bank-of-the-west"), "Bank of the West");
  assert.equal(prettyNickname("pnc-checking"), "PNC Checking");
  assert.equal(prettyNickname("td-visa"), "TD Visa");
  assert.equal(prettyNickname("usaa-savings"), "USAA Savings");
  assert.equal(prettyNickname("amex"), "Amex");
  assert.equal(prettyNickname("joint-checking"), "Joint Checking");
  assert.equal(prettyNickname("card-4417"), "Card 4417");
});

test("the dashboard and setup pages use the same naming rule as the server", () => {
  const rule = (src: string) => {
    const m = /var ACR = (\[[^\]]+\]), SMALL = (\[[^\]]+\]);/.exec(src);
    assert.ok(m, "page has the naming rule");
    return m![1] + m![2];
  };
  const dash = readFileSync(new URL("../src/ui/dashboard-page.ts", import.meta.url), "utf8");
  const setup = readFileSync(new URL("../src/ui/setup-page.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/health/status.ts", import.meta.url), "utf8");
  const sm = /NAME_ACRONYMS = (\[[^\]]+\]);\s*const NAME_SMALL = (\[[^\]]+\]);/.exec(server)!;
  assert.equal(rule(dash), sm[1] + sm[2]);
  assert.equal(rule(setup), sm[1] + sm[2]);
});
