/**
 * Cross-platform external URL opener with security validation.
 * Opens URLs in the system's default browser/handler.
 */

import { exec } from "node:child_process";

/**
 * Allowed URL schemes. Only these schemes will be opened externally.
 * This is a security measure to prevent opening potentially dangerous schemes.
 */
const ALLOWED_SCHEMES: readonly string[] = ["http:", "https:", "mailto:"];

/**
 * Error thrown when opening an external URL fails.
 */
class ExternalUrlError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "ExternalUrlError";
  }
}

/**
 * Validates a URL and checks if its scheme is allowed.
 * @param url - The URL to validate
 * @returns The parsed URL object
 * @throws Error if the URL is invalid or scheme is not allowed
 */
function validateUrl(url: string): URL {
  // Parse the URL (will throw if invalid)
  const parsed = new URL(url);

  // Check if the scheme is allowed
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`URL scheme '${parsed.protocol}' is not allowed`);
  }

  return parsed;
}

/**
 * Opens an external URL in the system's default browser/handler.
 *
 * Security:
 * - Validates URL scheme against allowlist before opening
 * - Throws for blocked schemes (file://, javascript:, data:, etc.)
 *
 * Platform behavior:
 * - Linux: gdbus portal → xdg-open fallback
 * - macOS: open command
 * - Windows: start command
 *
 * @param url - The URL to open
 * @returns Promise that resolves when URL is opened, rejects on failure
 * @throws Error if the URL is invalid or scheme is not allowed (sync)
 * @throws ExternalUrlError if opening fails (async, via Promise rejection)
 */
export async function openExternal(url: string): Promise<void> {
  // Validate URL and scheme (throws on failure)
  validateUrl(url);

  // Get platform-specific opener
  const platform = process.platform;

  if (platform === "linux") {
    return openOnLinux(url);
  } else if (platform === "darwin") {
    return openOnMac(url);
  } else if (platform === "win32") {
    return openOnWindows(url);
  } else {
    throw new ExternalUrlError(`Unsupported platform '${platform}'`, url);
  }
}

/**
 * Opens a URL on Linux using gdbus portal, falling back to xdg-open.
 */
function openOnLinux(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Try gdbus portal first (preferred, works in sandboxed environments)
    const gdbusCommand = `gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.OpenURI.OpenURI "" "${url}" {}`;

    exec(gdbusCommand, (error) => {
      if (error) {
        // Fallback to xdg-open
        exec(`xdg-open "${url}"`, (fallbackError) => {
          if (fallbackError) {
            reject(new ExternalUrlError("Failed to open external URL", url, fallbackError));
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Opens a URL on macOS using the open command.
 */
function openOnMac(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`open "${url}"`, (error) => {
      if (error) {
        reject(new ExternalUrlError("Failed to open external URL", url, error));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Opens a URL on Windows using the start command.
 */
function openOnWindows(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The empty string "" is for the window title (required for start command when URL has special chars)
    exec(`start "" "${url}"`, (error) => {
      if (error) {
        reject(new ExternalUrlError("Failed to open external URL", url, error));
      } else {
        resolve();
      }
    });
  });
}
