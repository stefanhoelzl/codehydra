/**
 * Test utilities for VS Code setup.
 */

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CURRENT_SETUP_VERSION, type SetupMarker } from "./types";

/**
 * Creates a mock setup state in a temporary directory.
 * Returns the vscode directory path.
 *
 * @param options - Options for the mock state
 * @returns Path to the temporary vscode directory
 */
export async function createMockSetupState(options: {
  /** Whether setup is complete (creates marker file) */
  complete?: boolean;
  /** Override the setup version in the marker */
  version?: number;
  /** Include custom extension files */
  includeExtensions?: boolean;
  /** Include config files */
  includeConfig?: boolean;
}): Promise<string> {
  const vscodeDir = join(
    tmpdir(),
    `codehydra-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(vscodeDir, { recursive: true });

  if (options.complete) {
    const marker: SetupMarker = {
      schemaVersion: options.version ?? CURRENT_SETUP_VERSION,
      completedAt: new Date().toISOString(),
    };
    await writeFile(join(vscodeDir, ".setup-completed"), JSON.stringify(marker, null, 2), "utf-8");
  }

  if (options.includeExtensions) {
    const extensionDir = join(vscodeDir, "extensions", "codehydra.sidekick-0.0.1-universal");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "package.json"),
      JSON.stringify({ name: "codehydra", version: "0.0.1" }, null, 2),
      "utf-8"
    );
    await writeFile(join(extensionDir, "extension.js"), "module.exports = {}", "utf-8");
  }

  if (options.includeConfig) {
    const userDir = join(vscodeDir, "user-data", "User");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "settings.json"),
      JSON.stringify(
        {
          "workbench.colorTheme": "Default Dark+",
          "window.autoDetectColorScheme": true,
          "workbench.preferredDarkColorTheme": "Default Dark+",
          "workbench.preferredLightColorTheme": "Default Light+",
        },
        null,
        2
      ),
      "utf-8"
    );
    await writeFile(
      join(userDir, "keybindings.json"),
      JSON.stringify(
        [
          { key: "ctrl+j", command: "-workbench.action.togglePanel" },
          { key: "alt+t", command: "workbench.action.togglePanel" },
        ],
        null,
        2
      ),
      "utf-8"
    );
  }

  return vscodeDir;
}

/**
 * Verifies that setup completed successfully in the given directory.
 *
 * @param vscodeDir - Path to the vscode directory
 * @returns True if setup is complete with current version
 */
export async function verifySetupCompleted(vscodeDir: string): Promise<boolean> {
  try {
    const content = await readFile(join(vscodeDir, ".setup-completed"), "utf-8");
    const marker = JSON.parse(content) as SetupMarker;
    return marker.schemaVersion === CURRENT_SETUP_VERSION;
  } catch {
    return false;
  }
}

/**
 * Creates a partial setup state (simulates interrupted setup).
 *
 * @returns Path to the temporary vscode directory
 */
export async function createPartialSetupState(): Promise<string> {
  // Create extensions but no marker = incomplete setup
  return createMockSetupState({
    complete: false,
    includeExtensions: true,
    includeConfig: false,
  });
}

/**
 * Gets the path to the code-server binary for testing.
 * In development, this is in node_modules/.bin/code-server.
 *
 * @returns Path to code-server binary
 */
export function getCodeServerTestPath(): string {
  // In development, code-server is installed as a devDependency
  // and available via PATH when running npm scripts
  return "code-server";
}

/**
 * Cleans up a test directory.
 *
 * @param dir - Directory to clean up
 */
export async function cleanupTestDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
