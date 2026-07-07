/**
 * code-server IdeServer descriptor.
 *
 * Captures every code-server-specific fact behind the IdeServer interface:
 * download coordinates (Coder releases; a CodeHydra fork for Windows), serve
 * flags, the `/healthz` readiness probe, and the `?folder=`/`?workspace=` URL
 * scheme. Pure — no I/O boundaries.
 */

import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";
import { assertWindowsX64 } from "../../utils/binary-download";
import { encodePathForUrl } from "../../boundaries/platform/paths";
import type { IdeServer, ServeArgsInput } from "./types";

/** Current version of code-server to download. */
export const CODE_SERVER_VERSION = "4.117.0";

/**
 * GitHub repository for Windows code-server builds. Windows builds are not
 * provided by the official code-server repo.
 */
const CODEHYDRA_REPO = "stefanhoelzl/codehydra";

/** Architecture name mappings for code-server releases. */
const CODE_SERVER_ARCH = {
  x64: "amd64",
  arm64: "arm64",
} as const;

/**
 * Normalize a path for use in code-server URLs. Handles Windows path
 * conversion (drive letters → leading-slash forward-slash form) and URL
 * encoding, preserving the drive-letter colon.
 */
function normalizePathForUrl(path: string): string {
  let normalizedPath = path;
  if (/^[A-Za-z]:/.test(path)) {
    normalizedPath = "/" + path.replace(/\\/g, "/");
  }
  return encodePathForUrl(normalizedPath).replace(/%3A/g, ":");
}

/**
 * Create the code-server IdeServer descriptor for a specific version
 * (defaults to the built-in `CODE_SERVER_VERSION`).
 */
export function createCodeServerIdeServer(version: string = CODE_SERVER_VERSION): IdeServer {
  return {
    id: "code-server",
    version,

    downloadUrl(platform: SupportedPlatform, arch: SupportedArch): string {
      assertWindowsX64(platform, arch, "code-server");
      if (platform === "win32") {
        return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${version}/code-server-${version}-win32-x64.tar.gz`;
      }
      const os = platform === "darwin" ? "macos" : "linux";
      const archName = CODE_SERVER_ARCH[arch];
      return `https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-${os}-${archName}.tar.gz`;
    },

    archiveSubPath(platform: SupportedPlatform, arch: SupportedArch): string {
      if (platform === "win32") {
        return `code-server-${version}-win32-x64`;
      }
      const os = platform === "darwin" ? "macos" : "linux";
      const archName = CODE_SERVER_ARCH[arch];
      return `code-server-${version}-${os}-${archName}`;
    },

    executablePath(platform: SupportedPlatform): string {
      return platform === "win32" ? "bin/code-server.cmd" : "bin/code-server";
    },

    bundleSubdir(): string {
      return `code-server/${version}`;
    },

    buildServeArgs({ port, extensionsDir, userDataDir }: ServeArgsInput): readonly string[] {
      return [
        "--bind-addr",
        `127.0.0.1:${port}`,
        "--auth",
        "none",
        "--disable-workspace-trust",
        "--disable-update-check",
        "--disable-telemetry",
        "--extensions-dir",
        extensionsDir,
        "--user-data-dir",
        userDataDir,
      ];
    },

    serveEnv(): Record<string, string> {
      // Disable code-server's localhost URL rewriting.
      return { VSCODE_PROXY_URI: "" };
    },

    healthUrl(port: number): string {
      return `http://127.0.0.1:${port}/healthz`;
    },

    urlForFolder(port: number, folderPath: string): string {
      return `http://127.0.0.1:${port}/?folder=${normalizePathForUrl(folderPath)}`;
    },

    urlForWorkspace(port: number, workspaceFilePath: string): string {
      return `http://127.0.0.1:${port}/?workspace=${normalizePathForUrl(workspaceFilePath)}`;
    },

    extraWorkspaceSettings(): Record<string, unknown> {
      // code-server disables workspace trust via a CLI flag, so no settings.
      return {};
    },
  };
}
