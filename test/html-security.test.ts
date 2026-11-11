import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, safeCssClass } from "../src/util/html";

test("HTML escaping protects text and quoted attribute contexts", () => {
  const hostile = "<" + "img src=x onerror=" + '"alert(1)">' + " & 'quoted'";
  assert.equal(escapeHtml(hostile), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(123), "123");
});

test("dynamic CSS classes accept only explicit status values", () => {
  const allowed = ["ok", "warn", "bad"] as const;
  assert.equal(safeCssClass("ok", allowed), "ok");
  assert.equal(safeCssClass("bad", allowed), "bad");
  assert.equal(safeCssClass("ok onload=alert(1)", allowed), "");
  assert.equal(safeCssClass(null, allowed), "");
});
