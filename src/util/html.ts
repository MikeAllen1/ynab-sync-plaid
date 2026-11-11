/** Escape untrusted values before inserting them into HTML text or quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Restrict dynamic CSS class fragments to an explicit allowlist. */
export function safeCssClass(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "";
}
