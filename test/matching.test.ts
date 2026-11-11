import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, ynabImportId, shortStableHash, nextOccurrence, seedOccurrenceCounts, normalizeMerchant, namesSimilar, namesConflict, leadingWordMatch, daysApart } from "../src/sync/matching";

test("cleanName pulls the company out of ACH text and tidies shouting", () => {
  assert.equal(cleanName("ORIG CO NAME:CITY UTILITIES CO ENTRY DESCR:BILL PAY SEC:WEB"), "City Utilities");
  assert.equal(cleanName("TARGET 00012345 03/09"), "Target");
  assert.equal(cleanName("Blue Bottle Coffee"), "Blue Bottle Coffee");
});

test("posted import ids use YNAB's own format, so Direct Import dedupes against them", () => {
  assert.equal(ynabImportId(-12340, "2026-03-10", 1), "YNAB:-12340:2026-03-10:1");
});

test("the same Plaid id always hashes the same; different ids differ", () => {
  assert.equal(shortStableHash("abc123"), shortStableHash("abc123"));
  assert.notEqual(shortStableHash("abc123"), shortStableHash("abc124"));
  const many = new Set(Array.from({ length: 5000 }, (_, i) => shortStableHash("pending-" + i)));
  assert.equal(many.size, 5000);
});

test("two identical charges on one day get occurrence 1 and 2", () => {
  const counts = seedOccurrenceCounts([]);
  assert.equal(nextOccurrence(counts, -5000, "2026-03-10"), 1);
  assert.equal(nextOccurrence(counts, -5000, "2026-03-10"), 2);
  assert.equal(nextOccurrence(counts, -5000, "2026-03-11"), 1);
});

test("merchant names are normalized: wallet prefixes, AMZN, noise words, long numbers", () => {
  assert.equal(normalizeMerchant("APLPAY CARIBOU COFFEE 123456"), "CARIBOU COFFEE");
  assert.equal(normalizeMerchant("AMZN Mktp US*2K4"), "AMAZON MKTP US 2K4");
  assert.equal(normalizeMerchant("SQ *THE CORNER CAFE"), "CORNER CAFE");
});

test("similar names match; different merchants conflict; abbreviations don't conflict", () => {
  assert.ok(namesSimilar("CORNER CAFE", "CORNER CAFE MAIN ST", []));
  assert.ok(namesSimilar("LUNDS BYERLYS", "LUNDSBYERLYS CH", []));
  assert.ok(!namesSimilar("WALMART", "TARGET", []));
  assert.ok(namesConflict("WALMART", "TARGET", []));
  assert.ok(!namesConflict("INTL HOUSE OF PANCAKES", "INTERNATIONAL HOUSE PANCAKES", []));
  assert.ok(leadingWordMatch("EASTVIEW LIGH", "EASTVIEW LGHTNING", []));
});

test("payee aliases make two names for one merchant match", () => {
  const aliases = [{ canonical: "NewCo Energy", patterns: ["oldco", "newco"] }];
  assert.ok(namesSimilar(normalizeMerchant("OLDCO BILLPAY"), normalizeMerchant("NewCo Energy"), aliases));
});

test("daysApart counts whole days and tolerates missing dates", () => {
  assert.equal(daysApart("2026-03-01", "2026-03-04"), 3);
  assert.equal(daysApart(undefined, "2026-03-04"), 0);
});
