import { test } from "node:test";
import assert from "node:assert/strict";
import { trackWriteFailures } from "../src/sync/engine";
import { rowOrigin } from "../src/sync/matching";
import { PERMANENT_FAILURE_CURSOR_RELEASE_DAYS } from "../src/constants";

test("rowOrigin tells the worker's Direct-Import-format posted rows from Direct Import's own", () => {
  const pins = new Set(["YNAB:-61470:2026-10-06:1"]);
  assert.equal(rowOrigin("YNAB:-61470:2026-10-06:1", pins), "worker (posted, Direct Import format)");
  assert.equal(rowOrigin("YNAB:-61470:2026-10-06:2", pins), "Direct Import");
  assert.equal(rowOrigin("wpend:abc", pins), "worker");
  assert.equal(rowOrigin("pcc:1:abc", pins), "worker");
  assert.equal(rowOrigin("pcp:1:abc", pins), "worker");
  assert.equal(rowOrigin(null, pins), "entered by hand");
  assert.equal(rowOrigin("somethingelse", pins), "other import");
});

test("trackWriteFailures: new failures hold the cursor and are reported once", () => {
  const r = trackWriteFailures({}, [{ id: "a", error: "YNAB update failed: 500" }, { id: "b", error: "YNAB update failed: 404" }], "2026-11-13");
  assert.deepEqual(r.nowFailed, { a: "2026-11-13", b: "2026-11-13" });
  assert.deepEqual(r.cursorBlockers, ["a", "b"]);
  assert.deepEqual([...r.firstSeen], ["a", "b"]);
  assert.deepEqual(r.releasedNow, []);
  const again = trackWriteFailures(r.nowFailed, [{ id: "a", error: "YNAB update failed: 500" }], "2026-11-14");
  assert.equal(again.firstSeen.size, 0, "not reported a second time");
  assert.deepEqual(again.nowFailed, { a: "2026-11-13" }, "the first-failure date is kept; b recovered and is dropped");
});

test("trackWriteFailures: an aged permanent refusal stops holding the cursor, released once", () => {
  const first = "2026-11-01";
  const later = new Date(Date.parse(first + "T00:00:00Z") + PERMANENT_FAILURE_CURSOR_RELEASE_DAYS * 86400000).toISOString().slice(0, 10);
  const r = trackWriteFailures({ p: first, t: first }, [{ id: "p", error: "failed: 422" }, { id: "t", error: "failed: 503" }], later);
  assert.deepEqual(r.cursorBlockers, ["t"], "a temporary failure always holds the cursor");
  assert.deepEqual(r.releasedNow, ["p"]);
  assert.equal(r.nowFailed.p, `${first}#released`);
  const next = trackWriteFailures(r.nowFailed, [{ id: "p", error: "failed: 422" }], later);
  assert.deepEqual(next.releasedNow, [], "the release is logged once");
  assert.equal(next.nowFailed.p, `${first}#released`);
});
