/**
 * Shared folder/workspace URL scheme for IDE servers.
 *
 * code-server and VSCodium's web workbench both open a folder or workspace via
 * the same `?folder=` / `?workspace=` query params (upstream VS Code behavior),
 * so both descriptors reuse these helpers.
 */

import { encodePathForUrl } from "../../boundaries/platform/paths";

/**
 * Normalize a path for use in an IDE server URL. Converts Windows drive paths
 * to leading-slash forward-slash form and URL-encodes each segment, preserving
 * the drive-letter colon.
 */
export function normalizePathForUrl(path: string): string {
  let normalizedPath = path;
  if (/^[A-Za-z]:/.test(path)) {
    normalizedPath = "/" + path.replace(/\\/g, "/");
  }
  return encodePathForUrl(normalizedPath).replace(/%3A/g, ":");
}

/** URL that opens a folder path on the given port. */
export function folderUrl(port: number, folderPath: string): string {
  return `http://127.0.0.1:${port}/?folder=${normalizePathForUrl(folderPath)}`;
}

/** URL that opens a `.code-workspace` file on the given port. */
export function workspaceUrl(port: number, workspaceFilePath: string): string {
  return `http://127.0.0.1:${port}/?workspace=${normalizePathForUrl(workspaceFilePath)}`;
}
