/**
 * HTML text helpers. Browser-compatible (no Node.js imports).
 */

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
