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

import vm from "node:vm";
import { dashboardHtml } from "../src/ui/dashboard-page";
import { setupHtml } from "../src/ui/setup-page";

// Our own trusted page templates, not untrusted HTML: plain string search for the inline
// <script> blocks (the external Plaid <script src=...> is skipped).
function inlineScripts(html: string): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf("<script nonce=", at);
    if (open < 0) break;
    const tagEnd = html.indexOf(">", open);
    const close = html.indexOf("</script>", tagEnd);
    if (tagEnd < 0 || close < 0) break;
    if (!/\ssrc=/.test(html.slice(open, tagEnd))) out.push(html.slice(tagEnd + 1, close));
    at = close;
  }
  return out.join("\n");
}

test("dashboard and setup page scripts define the escaping helpers they call", async () => {
  const pages = { dashboard: await dashboardHtml().text(), setup: setupHtml() };
  for (const [name, html] of Object.entries(pages)) {
    const script = inlineScripts(html);
    assert.ok(script.length > 0, `${name}: no inline script`);
    assert.doesNotThrow(() => new vm.Script(script), `${name}: script does not parse`);
    for (const fn of ["esc", "safeCssClass"]) {
      if (new RegExp(`[^.\\w]${fn}\\(`).test(script)) {
        assert.match(script, new RegExp(`function ${fn}\\(`), `${name}: calls ${fn}() but the page never defines it`);
      }
    }
    // The page copies behave like the server versions.
    const ctx: any = {};
    vm.runInNewContext(script.match(/function esc\([\s\S]*?\n/)![0] + (script.match(/function safeCssClass\([\s\S]*?\n/)?.[0] || ""), ctx);
    const hostile = "<" + "img src=x onerror=" + '"alert(1)">' + " & 'q'";
    assert.equal(ctx.esc(hostile), escapeHtml(hostile), `${name}: page esc differs from escapeHtml`);
    if (ctx.safeCssClass) assert.equal(ctx.safeCssClass("ok onload=x", ["ok"]), "");
  }
});

test("admin pages run under a nonce CSP with no inline event handlers", async () => {
  const response = dashboardHtml("test-nonce-1");
  const csp = response.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /script-src 'nonce-test-nonce-1'(;|$)/, "dashboard allows only its own nonce");
  assert.doesNotMatch(csp, /unsafe-inline[^;]*;?\s*$|script-src[^;]*unsafe/, "no unsafe script sources");
  const pages = { dashboard: await response.text(), setup: setupHtml("test-nonce-2") };
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${name}: inline event handler attribute found`);
    // Every opening script tag, found by plain (case-insensitive) string search.
    const lower = html.toLowerCase();
    for (let at = lower.indexOf("<script"); at >= 0; at = lower.indexOf("<script", at + 1)) {
      const tag = html.slice(at, html.indexOf(">", at) + 1);
      assert.match(tag, /nonce="test-nonce-[12]"/, `${name}: script without nonce: ${tag}`);
    }
  }
});
