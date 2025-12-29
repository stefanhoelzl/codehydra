/**
 * Path class for normalized, cross-platform path handling.
 *
 * This class encapsulates all path operations and normalizes paths to a canonical internal format:
 * - POSIX separators (forward slashes) always
 * - Absolute paths required (throws on relative paths)
 * - Case normalization on Windows (lowercase for case-insensitive filesystem)
 * - No trailing slashes (except root)
 * - No `.` or `..` segments (resolved)
 */

import * as nodePath from "node:path";

// Internal platform state (can be overridden for testing)
let isWindowsPlatform = process.platform === "win32";

/**
 * Set whether the platform is Windows for testing purposes.
 * @internal
 */
export function setPlatformForTesting(isWindows: boolean): void {
  isWindowsPlatform = isWindows;
}

/**
 * Reset platform detection to actual values.
 * @internal
 */
export function resetPlatform(): void {
  isWindowsPlatform = process.platform === "win32";
}

/**
 * Immutable path object that normalizes paths to a canonical internal format.
 *
 * ## Internal Format
 * - Always POSIX separators (forward slashes)
 * - Always absolute (relative paths throw error)
 * - Lowercase on Windows (case-insensitive filesystem)
 * - No trailing slashes (except root `/`)
 * - No `.` or `..` segments (resolved)
 *
 * ## Usage
 * ```typescript
 * // Single path (must be absolute)
 * const p1 = new Path("C:\\Users\\Name\\Project");
 * p1.toString(); // "c:/users/name/project"
 *
 * // Join paths
 * const p2 = new Path("/foo", "bar", "baz");
 * p2.toString(); // "/foo/bar/baz"
 *
 * // Extend existing path
 * const p3 = new Path(p2, "qux");
 * p3.toString(); // "/foo/bar/baz/qux"
 *
 * // Convert relative path (explicit)
 * const p4 = new Path(Path.cwd(), "./relative/path");
 *
 * // Comparison (never throws)
 * p1.equals(p2); // false
 * p1.equals("invalid"); // false (doesn't throw)
 *
 * // As Map key
 * const map = new Map<string, Data>();
 * map.set(path.toString(), data);
 * ```
 */
export class Path {
  private readonly _value: string;

  /**
   * Create a normalized Path.
   *
   * @param base - Base path (string or existing Path) - must be absolute
   * @param parts - Additional path segments to join (must not be empty/null)
   * @throws Error if path is empty, null, undefined, relative, or parts are invalid
   */
  constructor(base: string | Path, ...parts: string[]) {
    const joined = Path.joinParts(base, parts);
    this._value = Path.normalize(joined, isWindowsPlatform);
  }

  /**
   * Join base and parts, validating inputs.
   */
  private static joinParts(base: string | Path, parts: string[]): string {
    // Validate base
    if (base === null || base === undefined) {
      throw new Error("Path cannot be null or undefined");
    }

    const baseStr = base instanceof Path ? base._value : base;

    if (baseStr === "") {
      throw new Error("Path cannot be empty");
    }

    // Validate parts
    for (const part of parts) {
      if (part === null || part === undefined) {
        throw new Error("Path parts cannot be null or undefined");
      }
      if (part === "") {
        throw new Error("Path parts cannot be empty strings");
      }
    }

    // Join parts if provided
    if (parts.length > 0) {
      const posixBase = baseStr.replace(/\\/g, "/");
      return nodePath.posix.join(posixBase, ...parts);
    }

    return baseStr;
  }

  /**
   * Normalize a joined path string.
   */
  private static normalize(joined: string, isWindows: boolean): string {
    // Convert to POSIX format
    let normalized = joined.replace(/\\/g, "/");

    // Collapse multiple slashes (but preserve UNC paths on Windows: //server/share)
    if (isWindows && normalized.startsWith("//")) {
      // UNC path: preserve leading //, collapse rest
      normalized = "//" + normalized.slice(2).replace(/\/+/g, "/");
    } else {
      normalized = normalized.replace(/\/+/g, "/");
    }

    // Check if path is absolute
    const isAbsolute = normalized.startsWith("/") || (isWindows && /^[a-zA-Z]:\//.test(normalized));

    if (!isAbsolute) {
      throw new Error(
        `Path must be absolute, got relative path: "${joined}". ` +
          `Use new Path(Path.cwd(), "${joined}") to convert relative paths.`
      );
    }

    // Resolve .. and . segments
    const segments = normalized.split("/");
    const resolvedSegments: string[] = [];

    for (const segment of segments) {
      if (segment === "..") {
        if (resolvedSegments.length > 1) {
          resolvedSegments.pop();
        }
      } else if (segment !== "." && segment !== "") {
        resolvedSegments.push(segment);
      } else if (segment === "" && resolvedSegments.length === 0) {
        resolvedSegments.push("");
      }
    }

    normalized = resolvedSegments.join("/");

    // Ensure Unix paths start with /
    if (!isWindows && !normalized.startsWith("/")) {
      normalized = "/" + normalized;
    }

    // Remove trailing slash (except root)
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    // Handle Windows root path (e.g., "C:" -> "C:/")
    if (isWindows && /^[a-zA-Z]:$/.test(normalized)) {
      normalized = normalized + "/";
    }

    // Lowercase on Windows (case-insensitive filesystem)
    if (isWindows) {
      normalized = normalized.toLowerCase();
    }

    return normalized;
  }

  /**
   * Get the current working directory as a Path.
   */
  static cwd(): Path {
    return new Path(process.cwd());
  }

  /**
   * Get the normalized path string.
   * Use for Map keys, comparisons, and serialization.
   */
  toString(): string {
    return this._value;
  }

  /**
   * Get path in OS-native format.
   * Use when calling node:fs, spawning processes, or other OS APIs.
   */
  toNative(): string {
    if (isWindowsPlatform) {
      return this._value.replace(/\//g, "\\");
    }
    return this._value;
  }

  /**
   * JSON serialization - returns normalized string.
   */
  toJSON(): string {
    return this._value;
  }

  /**
   * Implicit string conversion.
   */
  valueOf(): string {
    return this._value;
  }

  /**
   * For debugging - shows "Path" in console.
   */
  get [Symbol.toStringTag](): string {
    return "Path";
  }

  /**
   * Check equality with another path.
   * Returns false for invalid paths (never throws).
   */
  equals(other: Path | string): boolean {
    if (other instanceof Path) {
      return this._value === other._value;
    }
    try {
      return this._value === new Path(other)._value;
    } catch {
      return false;
    }
  }

  /**
   * Check if this path starts with a prefix.
   * Returns false for invalid prefix (never throws).
   */
  startsWith(prefix: Path | string): boolean {
    try {
      const prefixStr = prefix instanceof Path ? prefix._value : new Path(prefix)._value;
      return this._value === prefixStr || this._value.startsWith(prefixStr + "/");
    } catch {
      return false;
    }
  }

  /**
   * Check if this path is a child of (contained within) a parent path.
   * Unlike startsWith(), this properly handles edge cases like /foo vs /foo-bar.
   * Returns false if paths are equal (a path is not its own child).
   */
  isChildOf(parent: Path | string): boolean {
    try {
      const parentStr = parent instanceof Path ? parent._value : new Path(parent)._value;
      // Must start with parent + "/" to be a proper child
      return this._value.startsWith(parentStr + "/");
    } catch {
      return false;
    }
  }

  /**
   * Get relative path from a base.
   * Returns POSIX-style relative path string.
   * Note: Returns string, not Path, since relative paths cannot be Path instances.
   */
  relativeTo(base: Path | string): string {
    const baseStr = base instanceof Path ? base._value : new Path(base)._value;
    return nodePath.posix.relative(baseStr, this._value);
  }

  /**
   * Get the filename or final directory name.
   */
  get basename(): string {
    return nodePath.posix.basename(this._value);
  }

  /**
   * Get the parent directory as a Path.
   */
  get dirname(): Path {
    const dir = nodePath.posix.dirname(this._value);
    return new Path(dir);
  }

  /**
   * Get the file extension (including the dot).
   */
  get extension(): string {
    return nodePath.posix.extname(this._value);
  }

  /**
   * Get path segments as array.
   */
  get segments(): string[] {
    return this._value.split("/").filter(Boolean);
  }
}
