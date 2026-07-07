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
import type { IdeServer, ServeArgsInput, RemoteCliInvocation } from "./types";
import { folderUrl, workspaceUrl } from "./url-scheme";

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
      return folderUrl(port, folderPath);
    },

    urlForWorkspace(port: number, workspaceFilePath: string): string {
      return workspaceUrl(port, workspaceFilePath);
    },

    remoteCli(bundleDir: string, platform: SupportedPlatform): RemoteCliInvocation {
      if (platform === "win32") {
        return {
          exe: `${bundleDir}\\lib\\node.exe`,
          args: [
            `${bundleDir}\\lib\\vscode\\out\\server-cli.js`,
            "code-server",
            "",
            "",
            "code.cmd",
          ],
        };
      }
      const os = platform === "darwin" ? "darwin" : "linux";
      return { exe: `${bundleDir}/lib/vscode/bin/remote-cli/code-${os}.sh`, args: [] };
    },

    nodeBinary(bundleDir: string, platform: SupportedPlatform): string {
      return platform === "win32" ? `${bundleDir}\\lib\\node.exe` : `${bundleDir}/lib/node`;
    },
  };
}
