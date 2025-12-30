/**
 * Utilities for parsing VS Code extension directory names.
 *
 * VS Code stores extensions in directories named `<publisher>.<name>-<version>`:
 * - Standard versions: `publisher.name-1.0.0`
 * - Prerelease versions: `publisher.name-1.0.0-beta.1`
 * - Build metadata: `publisher.name-1.0.0+build123`
 */

import type { FileSystemLayer, PathLike } from "../platform/filesystem";
import { Path } from "../platform/path";

/**
 * Parsed extension info from a directory name.
 */
export interface ParsedExtension {
  /** Extension ID in publisher.name format */
  readonly id: string;
  /** Extension version */
  readonly version: string;
}

/**
 * Regex pattern to parse extension directory names.
 *
 * Captures:
 * - Group 1: Extension ID (publisher.name format, at least one dot required)
 * - Group 2: Version (everything after the first hyphen that follows the ID)
 *
 * The pattern handles:
 * - Standard versions: 1.0.0
 * - Prerelease versions: 1.0.0-beta.1, 1.0.0-alpha
 * - Build metadata: 1.0.0+build123
 */
const EXTENSION_DIR_PATTERN = /^([a-z0-9-]+\.[a-z0-9-]+)-(.+)$/i;

/**
 * Parse an extension directory name into ID and version.
 *
 * @param dirName Directory name (e.g., "codehydra.codehydra-0.0.1")
 * @returns Parsed extension info or null if the name doesn't match the pattern
 *
 * @example
 * parseExtensionDir("codehydra.codehydra-0.0.1")
 * // Returns: { id: "codehydra.codehydra", version: "0.0.1" }
 *
 * @example
 * parseExtensionDir("publisher.name-1.0.0-beta.1")
 * // Returns: { id: "publisher.name", version: "1.0.0-beta.1" }
 *
 * @example
 * parseExtensionDir(".DS_Store")
 * // Returns: null (hidden file)
 */
export function parseExtensionDir(dirName: string): ParsedExtension | null {
  // Ignore hidden files and directories
  if (dirName.startsWith(".")) {
    return null;
  }

  // Ignore common non-extension directories
  if (dirName === "node_modules") {
    return null;
  }

  const match = EXTENSION_DIR_PATTERN.exec(dirName);
  if (!match) {
    return null;
  }

  const id = match[1];
  const version = match[2];

  // Additional validation: ensure ID has at least one dot (publisher.name format)
  if (!id || !id.includes(".") || !version) {
    return null;
  }

  return { id, version };
}

/**
 * List all installed extensions in a directory.
 *
 * @param fs FileSystemLayer instance
 * @param extensionsDir Path to the extensions directory (Path object or string)
 * @returns Map of extension ID to installed version
 *
 * @example
 * const extensions = await listInstalledExtensions(fs, "/app/vscode/extensions");
 * // Returns: Map { "codehydra.codehydra" => "0.0.1", "sst-dev.opencode" => "1.2.3" }
 */
export async function listInstalledExtensions(
  fs: FileSystemLayer,
  extensionsDir: PathLike
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  try {
    const entries = await fs.readdir(extensionsDir);

    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }

      const parsed = parseExtensionDir(entry.name);
      if (parsed) {
        // If multiple versions of the same extension exist, keep the last one found
        // (VS Code typically only keeps one version per extension)
        result.set(parsed.id, parsed.version);
      }
    }
  } catch {
    // Directory doesn't exist or is unreadable - return empty map
    // This is expected during first-run setup
  }

  return result;
}

/**
 * Entry in VS Code's extensions.json file.
 * Only includes fields we need for filtering.
 */
interface ExtensionsJsonEntry {
  readonly identifier: { readonly id: string };
  readonly version: string;
  // Other fields exist but we preserve them as-is
}

/**
 * Remove entries for specified extension IDs from VS Code's extensions.json.
 *
 * This is needed to clear stale state that can prevent reinstallation.
 * VS Code may reject installing an extension if it's still registered
 * in extensions.json even though the extension folder is missing.
 *
 * @param fs FileSystemLayer instance
 * @param extensionsDir Path to the extensions directory containing extensions.json
 * @param extensionIds Extension IDs to remove from the registry
 *
 * @example
 * await removeFromExtensionsJson(fs, "/app/vscode/extensions", ["sst-dev.opencode"]);
 */
export async function removeFromExtensionsJson(
  fs: FileSystemLayer,
  extensionsDir: PathLike,
  extensionIds: readonly string[]
): Promise<void> {
  if (extensionIds.length === 0) {
    return;
  }

  const jsonPath = new Path(extensionsDir, "extensions.json");

  let content: string;
  try {
    content = await fs.readFile(jsonPath);
  } catch {
    // File doesn't exist - nothing to clean
    return;
  }

  let entries: ExtensionsJsonEntry[];
  try {
    entries = JSON.parse(content) as ExtensionsJsonEntry[];
  } catch {
    // Invalid JSON - don't modify
    return;
  }

  if (!Array.isArray(entries)) {
    return;
  }

  // Create a Set for O(1) lookup (case-insensitive)
  const idsToRemove = new Set(extensionIds.map((id) => id.toLowerCase()));

  // Filter out entries for the specified extension IDs
  const filtered = entries.filter(
    (entry) => !idsToRemove.has(entry.identifier?.id?.toLowerCase() ?? "")
  );

  // Only write if we actually removed something
  if (filtered.length < entries.length) {
    await fs.writeFile(jsonPath, JSON.stringify(filtered));
  }
}
