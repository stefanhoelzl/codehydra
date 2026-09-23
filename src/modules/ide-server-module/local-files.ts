/**
 * Local files in Simple Browser.
 *
 * Simple Browser renders its page in an `<iframe>` inside a webview, and the
 * webview lives on an https origin (`*.vscode-cdn.net`). Blink refuses to load a
 * `file:` URL into a frame of a web origin ("Not allowed to load local
 * resource") — in the renderer, before any request exists, so a session handler
 * for the `file` scheme never even sees it. A `file://` URL therefore rendered a
 * blank white page.
 *
 * The fix has two halves:
 *
 * - A bundle patch (`SIMPLE_BROWSER_LOCAL_FILES` in `bundle-patches.ts`) rewrites
 *   `file:///a/b.html` to `https://file.codehydra.invalid/a/b.html` at the one
 *   spot where Simple Browser sets its iframe's `src`, which every entry point
 *   (address bar, `simpleBrowser.show`, `ch vscode browser`) goes through.
 * - The https interceptor the IDE server module already registers on the
 *   workspace session answers that host from disk.
 *
 * The path keeps its structure, so relative links and subresources resolve on
 * their own. `.invalid` is reserved (RFC 2606) and never resolves, so the host
 * can not collide with a real site — and a request the interceptor declines
 * fails as a DNS error rather than reaching the network.
 *
 * Everything here is pure; the module does the reading.
 */

import mime from "mime";

import type { DirEntry } from "../../boundaries/platform/filesystem";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";

/** The synthetic host the patched Simple Browser rewrites `file://` URLs to. */
export const LOCAL_FILE_HOST = "file.codehydra.invalid";

/** A request for a local file, parsed from its rewritten URL. */
export interface LocalFileRequest {
  /** Absolute path of the file or directory, forward slashes (`C:/x` on Windows). */
  readonly path: string;
  /** Whether the URL path ends in `/` (a directory URL relative links can resolve against). */
  readonly trailingSlash: boolean;
  /** Last URL path segment, still encoded; `""` for the root. */
  readonly lastSegment: string;
}

/**
 * Parse a rewritten local-file URL, or `null` when the URL is not one.
 *
 * On Windows the drive stays in the URL path (`/C:/x/r.html`), exactly as it
 * does in the `file:///C:/x/r.html` it came from, and is lifted back out here.
 */
export function parseLocalFileUrl(
  url: string,
  platform: SupportedPlatform
): LocalFileRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== LOCAL_FILE_HOST) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  let path = decoded;
  if (platform === "win32") {
    if (!/^\/[A-Za-z]:(\/|$)/.test(decoded)) return null;
    path = decoded.slice(1);
    // `C:` alone is the drive's current directory, not its root.
    if (path.length === 2) path += "/";
  }

  const segments = parsed.pathname.split("/");
  return {
    path,
    trailingSlash: parsed.pathname.endsWith("/"),
    lastSegment: segments[segments.length - 1] ?? "",
  };
}

/** Content type for a served file, from its extension. */
export function localFileContentType(filePath: string): string {
  const type = mime.getType(filePath) ?? "application/octet-stream";
  // Without a charset Chromium guesses (often windows-1252) and mangles UTF-8.
  return type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type;
}

/**
 * A page that sends a directory URL without its trailing slash on to the one
 * with it, so the relative links of its `index.html` or listing resolve inside
 * the directory rather than next to it. A page, not a redirect status, because
 * the session's protocol interceptor only answers 200.
 */
export function directorySlashRedirect(lastSegment: string): string {
  const target = escapeHtml(`${lastSegment}/`);
  return `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}">`;
}

/** A plain HTML listing of a directory: folders first, then files, by name. */
export function directoryListing(displayPath: string, entries: readonly DirEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
  );
  const items = sorted.map((entry) => {
    const suffix = entry.isDirectory ? "/" : "";
    const href = escapeHtml(encodeURIComponent(entry.name) + suffix);
    return `<li><a href="${href}">${escapeHtml(entry.name + suffix)}</a></li>`;
  });
  const title = escapeHtml(displayPath);
  const up = isRoot(displayPath) ? "" : `<li><a href="../">../</a></li>`;
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:1em 2em}li{list-style:none;line-height:1.6}</style>` +
    `</head><body><h1>${title}</h1><ul>${up}${items.join("")}</ul></body></html>`
  );
}

function isRoot(path: string): boolean {
  return /^(\/|[A-Za-z]:\/?)$/.test(path);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
