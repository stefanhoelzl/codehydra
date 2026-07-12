/**
 * IdeServer — the distribution-specific surface of an embedded IDE server.
 *
 * The generic `IdeServerModule` owns the shared lifecycle (download, spawn,
 * health-poll, kill, resume, extension install, and per-workspace
 * `.code-workspace` file writing). Everything that differs between IDE server
 * distributions (VSCodium reh-web, …) lives behind this
 * descriptor: download coordinates, serve arguments, the readiness probe, the
 * folder/workspace URL scheme, and any settings a distribution needs injected.
 *
 * Implementations are pure — they take no I/O boundaries. The module assembles
 * paths and download requests from the coordinates a descriptor returns.
 */

import type { SupportedPlatform, SupportedArch } from "../../boundaries/platform/platform-info";
import type { BinaryType } from "../../utils/binary-resolution/types";

/** Inputs needed to build the server's serve command line. */
export interface ServeArgsInput {
  readonly port: number;
  readonly extensionsDir: string;
  readonly userDataDir: string;
}

/**
 * How the `code` terminal wrapper invokes this distribution's remote-cli:
 * an executable plus fixed leading arguments (empty for a direct script).
 */
export interface RemoteCliInvocation {
  readonly exe: string;
  readonly args: readonly string[];
}

export interface IdeServer {
  /** Binary identifier, also the download/preflight name (e.g. "vscodium"). */
  readonly id: BinaryType;
  /** Distribution version; drives download coordinates and the bundle directory. */
  readonly version: string;

  /** Download URL for the given platform/arch. */
  downloadUrl(platform: SupportedPlatform, arch: SupportedArch): string;
  /**
   * Prefix of the extracted archive's top-level directory, or `undefined` when
   * the archive has no wrapping directory (contents sit at the root).
   */
  archiveSubPath(platform: SupportedPlatform, arch: SupportedArch): string | undefined;
  /** Relative path to the executable to spawn, within the extracted bundle. */
  executablePath(platform: SupportedPlatform): string;
  /**
   * Leading arguments before any CLI flags, as paths relative to the bundle.
   *
   * We spawn the bundle's own node with the server entry point rather than the
   * `bin/codium-server` wrapper, on every platform. On Windows the wrapper cannot
   * work at all: a `.cmd` goes through cmd.exe, cross-spawn quotes every argument,
   * and VSCodium's script evaluates `if "%_FIRST_ARG:~0,9%"=="--inspect"` against a
   * quoted `%1` — unbalanced quotes, unparseable `if`, exit 255. The POSIX wrapper
   * works, but only ever execs the same node; its one extra behaviour, a patchelf
   * step, is gated on `VSCODE_SERVER_CUSTOM_GLIBC_*`, and the serve environment
   * strips every `VSCODE_*` variable before spawning. Same command, no shell.
   */
  entryArgs(): readonly string[];
  /** Bundle subdirectory under bundlePath (e.g. "vscodium/<version>"). */
  bundleSubdir(): string;

  /** CLI arguments to serve on `port` with the given extension/user-data dirs. */
  buildServeArgs(input: ServeArgsInput): readonly string[];
  /** Extra environment variables for the server process (merged into the base env). */
  serveEnv(): Record<string, string>;

  /** Readiness probe URL for the given port. */
  healthUrl(port: number): string;

  /**
   * Map a request URL to the bundle-relative path of the webview asset that
   * should answer it, or `null` when the URL is not a webview asset request.
   *
   * Why this exists: the distribution bakes an external webview base URL into
   * its compiled workbench (`webviewContentExternalBaseUrlTemplate`), and for
   * VSCodium that URL points at a *Microsoft* build on `vscode-cdn.net` whose
   * webview service-worker is v4 while VSCodium's own workbench requires v5.
   * The mismatch breaks every webview (Simple Browser, markdown preview, ...),
   * and it is unfixable by repointing the URL: the CDN hosts no assets for
   * VSCodium's commit at all. So the shell intercepts these requests and serves
   * the bundle's own matching assets *at the original URL* — which keeps the
   * per-webview origin isolation the CDN hostname provides, and works offline.
   *
   * Pure: parses the URL only. The caller does the reading.
   */
  webviewAsset(url: string): string | null;

  /** URL that opens a folder path. */
  urlForFolder(port: number, folderPath: string): string;
  /** URL that opens a `.code-workspace` file. */
  urlForWorkspace(port: number, workspaceFilePath: string): string;

  /**
   * The remote-cli invocation the `code` terminal wrapper runs, given the
   * extracted bundle directory. Owns the distribution's on-disk layout so the
   * wrapper scripts stay distribution-agnostic.
   */
  remoteCli(bundleDir: string, platform: SupportedPlatform): RemoteCliInvocation;

  /** Absolute path to the bundled Node binary used by the agent wrappers. */
  nodeBinary(bundleDir: string, platform: SupportedPlatform): string;
}
