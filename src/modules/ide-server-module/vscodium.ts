/**
 * VSCodium (reh-web) IdeServer descriptor.
 *
 * VSCodium ships an official "remote extension host — web" build for every
 * platform CodeHydra targets (Linux/macOS x64+arm64, Windows x64), from the
 * VSCodium GitHub releases. Facts here were verified against the real build:
 * launcher `bin/codium-server`, a flat archive (no wrapping dir), readiness at
 * `/version` (no `/healthz`), and the same upstream `?folder=`/`?workspace=`
 * URL scheme. `--disable-workspace-trust` is accepted (it flips the workbench's
 * injected `enableWorkspaceTrust` to false) even though it isn't in `--help`.
 * Pure — no I/O boundaries.
 */

import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";
import { assertWindowsX64 } from "../../utils/binary-download";
import type { IdeServer, ServeArgsInput, RemoteCliInvocation } from "./types";
import { folderUrl, workspaceUrl } from "./url-scheme";

/** Current VSCodium version to download (reh-web build; VS Code <major.minor>.<build>). */
export const VSCODIUM_VERSION = "1.126.04524";

/** Map Node's platform to the VSCodium release asset OS token. */
function osToken(platform: SupportedPlatform): string {
  // VSCodium asset names use "darwin"/"linux"/"win32" directly.
  return platform;
}

/**
 * Create the VSCodium IdeServer descriptor for a specific version
 * (defaults to the built-in `VSCODIUM_VERSION`).
 */
export function createVscodiumIdeServer(version: string = VSCODIUM_VERSION): IdeServer {
  return {
    id: "vscodium",
    version,

    downloadUrl(platform: SupportedPlatform, arch: SupportedArch): string {
      assertWindowsX64(platform, arch, "vscodium");
      const os = osToken(platform);
      return `https://github.com/VSCodium/vscodium/releases/download/${version}/vscodium-reh-web-${os}-${arch}-${version}.tar.gz`;
    },

    archiveSubPath(): string | undefined {
      // The reh-web tarball is flat — contents sit at the archive root.
      return undefined;
    },

    executablePath(platform: SupportedPlatform): string {
      return platform === "win32" ? "bin/codium-server.cmd" : "bin/codium-server";
    },

    bundleSubdir(): string {
      return `vscodium/${version}`;
    },

    buildServeArgs({ port, extensionsDir, userDataDir }: ServeArgsInput): readonly string[] {
      return [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--without-connection-token",
        "--accept-server-license-terms",
        "--disable-workspace-trust",
        "--server-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--telemetry-level",
        "off",
      ];
    },

    serveEnv(): Record<string, string> {
      return {};
    },

    healthUrl(port: number): string {
      // reh-web has no /healthz; /version returns 200 once the server is up.
      return `http://127.0.0.1:${port}/version`;
    },

    urlForFolder(port: number, folderPath: string): string {
      return folderUrl(port, folderPath);
    },

    urlForWorkspace(port: number, workspaceFilePath: string): string {
      return workspaceUrl(port, workspaceFilePath);
    },

    remoteCli(bundleDir: string, platform: SupportedPlatform): RemoteCliInvocation {
      // The reh-web remote-cli is a single directly-runnable script.
      return platform === "win32"
        ? { exe: `${bundleDir}\\bin\\remote-cli\\codium.cmd`, args: [] }
        : { exe: `${bundleDir}/bin/remote-cli/codium`, args: [] };
    },

    nodeBinary(bundleDir: string, platform: SupportedPlatform): string {
      // reh-web keeps node at the archive root, not under lib/.
      return platform === "win32" ? `${bundleDir}\\node.exe` : `${bundleDir}/node`;
    },
  };
}
