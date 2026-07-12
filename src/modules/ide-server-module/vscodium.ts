/**
 * VSCodium (reh-web) IdeServer descriptor.
 *
 * VSCodium ships an official "remote extension host — web" build for every
 * platform CodeHydra targets (Linux/macOS x64+arm64, Windows x64), from the
 * VSCodium GitHub releases. Facts here were verified against the real build:
 * a bundled `node` and `out/server-main.js` at the archive root, a flat archive
 * (no wrapping dir), readiness at
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

/** Bundle-relative directory holding the webview shell (index/fake html + service worker). */
const WEBVIEW_PRE_DIR = "out/vs/workbench/contrib/webview/browser/pre";

/** The same directory as it appears in the baked webview base URL. */
const WEBVIEW_PRE_PATH = `/${WEBVIEW_PRE_DIR}/`;

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
      // Not bin/codium-server — see IdeServer.entryArgs. The reh-web bundle ships
      // its own node at the archive root.
      return platform === "win32" ? "node.exe" : "node";
    },

    entryArgs(): readonly string[] {
      return ["out/server-main.js"];
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

    webviewAsset(url: string): string | null {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      // Webviews are framed from `https://<uuid>.vscode-cdn.net/<quality>/<commit>{WEBVIEW_PRE_PATH}`.
      if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vscode-cdn.net")) {
        return null;
      }
      const index = parsed.pathname.indexOf(WEBVIEW_PRE_PATH);
      if (index === -1) return null;

      // The workbench only ever asks for flat files here (index.html, fake.html,
      // service-worker.js). Reject anything with a separator or traversal so a
      // crafted URL can't escape the bundle.
      const file = parsed.pathname.slice(index + WEBVIEW_PRE_PATH.length);
      if (file === "") return `${WEBVIEW_PRE_DIR}/index.html`;
      if (file.includes("/") || file.includes("\\") || file.includes("..")) return null;

      return `${WEBVIEW_PRE_DIR}/${file}`;
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
