/**
 * Agent binary resolution — which executable an agent runs, and getting it.
 *
 * One rule set for every agent (Claude, OpenCode):
 * 1. `version.<agent>` set → that version, downloaded into
 *    `<bundles>/<agent>/<version>/` if missing. A channel word (`latest`,
 *    `stable`) is resolved to a version first. Beats a system install.
 * 2. Otherwise the system install: first match on the app's PATH whose
 *    `--version` runs a supported major (see `supportedMajors`); the version
 *    it reported is carried along.
 * 3. Otherwise the agent's default channel, downloaded like (1).
 *
 * A channel is re-resolved every startup. When the lookup fails the newest
 * version already downloaded is used; when a newer version exists while an
 * older one is present, the older one is used now and the newer one downloads
 * in the background — new workspaces pick it up once it lands.
 *
 * Nothing is recorded: the version directories are the record.
 */

import type {
  DownloadRequest,
  DownloadDeps,
  DownloadProgressCallback,
} from "../../utils/binary-download";
import { downloadBinary } from "../../utils/binary-download";
import type { DirEntry, FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { HttpClient } from "../../boundaries/platform/network";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type {
  ProcessOptions,
  ProcessRunner,
  SpawnedProcess,
} from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
import {
  AgentBinaryError,
  BinaryDownloadError,
  FileSystemError,
  getErrorMessage,
} from "../../shared/errors/service-errors";
import { Path } from "../../utils/path/path";
import { cmdCommandLine, needsCmdShell } from "./cmd-quote";

// =============================================================================
// Types
// =============================================================================

/** Where the binary an agent runs came from. */
export type AgentBinarySource = "system" | "download";

/** The executable an agent runs. */
export interface ResolvedAgentBinary {
  /** Absolute native path. */
  readonly path: string;
  readonly source: AgentBinarySource;
  /**
   * The version it runs: what was downloaded, or what a system install
   * reported for `--version`. Null when it could not be read.
   */
  readonly version: string | null;
}

/**
 * Per-agent download coordinates. Platform-specific values are baked in by
 * the agent's factory (see `claude/setup-info.ts`, `opencode/setup-info.ts`).
 */
export interface AgentBinaryDescriptor {
  /** Bundle directory name and log label (e.g. "claude"). */
  readonly name: string;
  /** Version values that track a channel rather than name a version. */
  readonly channels: readonly string[];
  /** Channel used when nothing is configured and nothing is installed. */
  readonly defaultChannel: string;
  /** The executable's file name inside a version directory. */
  readonly executablePath: string;
  /** File names to look for on PATH, in preference order. */
  readonly systemCandidates: readonly string[];
  /**
   * Major versions whose server API the app can talk to. A system install of
   * any other major (by its `--version`) is skipped like one that does not
   * run; a download of one — pinned, or what a channel named — fails. Undefined
   * accepts every version.
   */
  readonly supportedMajors?: readonly number[];
  /** Resolve a channel to the version it currently points at. */
  resolveChannel(channel: string, httpClient: Pick<HttpClient, "fetch">): Promise<string>;
  /** Build the download request for `version` into `destDir`. */
  downloadRequest(
    version: string,
    destDir: string,
    httpClient: Pick<HttpClient, "fetch">
  ): Promise<DownloadRequest>;
}

export interface AgentBinaryResolverDeps {
  readonly descriptor: AgentBinaryDescriptor;
  /** `version.<agent>`, read when resolving. */
  readonly version: { get(): string | null };
  readonly pathProvider: Pick<PathProvider, "bundlePath">;
  readonly fileSystem: Pick<FileSystemBoundary, "readdir">;
  readonly processRunner: Pick<ProcessRunner, "run">;
  readonly downloadDeps: DownloadDeps;
  /** The environment whose PATH decides what is installed (the app's own). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: SupportedPlatform;
  readonly logger: Logger;
}

export interface AgentBinaryResolver {
  /**
   * Resolve the binary for this launch. Succeeds once and is then reused;
   * `needsDownload` means `download()` must run before the agent can start.
   */
  prepare(): Promise<{ readonly needsDownload: boolean }>;
  /** Download what `prepare()` found missing. No-op when nothing is. */
  download(onProgress?: DownloadProgressCallback): Promise<void>;
  /** The binary a workspace launched now should run, or null before one is known. */
  current(): ResolvedAgentBinary | null;
  /**
   * Download the configured version (or the default channel) whatever is
   * installed on the system — for `--download-binaries`. Skips a version that
   * is already present.
   */
  seed(onProgress?: DownloadProgressCallback): Promise<string>;
  /**
   * Version directories to keep: the one in use plus any still downloading.
   * Null until this launch has resolved, so nothing is swept on a guess.
   */
  bundleVersionsInUse(): readonly string[] | null;
  /** Settles when no background download is in flight (for tests and shutdown). */
  idle(): Promise<void>;
}

/** Timeout for resolving a channel: a small text/redirect request. */
const CHANNEL_TIMEOUT_MS = 15_000;

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Order two version strings, newest first when used with sort(). Numeric
 * segments compare as numbers; a release sorts above its prereleases.
 */
export function compareVersions(a: string, b: string): number {
  const [aMain = "", aPre] = splitPrerelease(a);
  const [bMain = "", bPre] = splitPrerelease(b);
  const aParts = aMain.split(".");
  const bParts = bMain.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = segmentValue(aParts[i]) - segmentValue(bParts[i]);
    if (diff !== 0) return diff;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
}

function splitPrerelease(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  return dash === -1 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}

function segmentValue(segment: string | undefined): number {
  const n = Number.parseInt(segment ?? "0", 10);
  return Number.isNaN(n) ? 0 : n;
}

/** A directory name that looks like a version we downloaded. */
function isVersionName(name: string): boolean {
  return /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(name);
}

/**
 * The x.y.z in a `--version` output — "opencode v2.1.4", "1.2.3 (Claude
 * Code)" — or null when the output names no version.
 */
export function parseAgentVersion(output: string): string | null {
  return /v?(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** PATH from an environment, whatever its key's case (Windows uses `Path`). */
export function pathEntries(
  env: Readonly<Record<string, string | undefined>>,
  platform: SupportedPlatform
): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const value = key === undefined ? undefined : env[key];
  if (!value) return [];
  return value.split(platform === "win32" ? ";" : ":").filter((entry) => entry.length > 0);
}

/**
 * Spawn an agent executable. A Windows `.cmd` shim (what npm installs) needs a
 * shell: Node refuses to spawn one directly, and the shell needs every part of
 * the command line quoted (see cmd-quote.ts).
 */
export function runAgentBinary(
  processRunner: Pick<ProcessRunner, "run">,
  executable: string,
  args: readonly string[],
  platform: SupportedPlatform,
  options?: Omit<ProcessOptions, "shell">
): SpawnedProcess {
  if (needsCmdShell(executable, platform)) {
    return processRunner.run(cmdCommandLine(executable, args), [], {
      ...options,
      shell: true,
    });
  }
  return processRunner.run(executable, args, options);
}

// =============================================================================
// Resolver
// =============================================================================

type Pending = { readonly version: string } | { readonly channel: string };

export function createAgentBinaryResolver(deps: AgentBinaryResolverDeps): AgentBinaryResolver {
  const { descriptor, pathProvider, fileSystem, processRunner, downloadDeps, platform, logger } =
    deps;
  const httpClient = downloadDeps.httpClient;

  let resolved = false;
  let currentBinary: ResolvedAgentBinary | null = null;
  let pending: Pending | null = null;
  /** In-flight downloads by version, so concurrent requests share one. */
  const inFlight = new Map<string, Promise<void>>();
  let background: Promise<void> | null = null;

  function versionDir(version: string): Path {
    return pathProvider.bundlePath(`${descriptor.name}/${version}`);
  }

  function downloaded(version: string): ResolvedAgentBinary {
    return {
      path: new Path(versionDir(version), descriptor.executablePath).toNative(),
      source: "download",
      version,
    };
  }

  async function listOrEmpty(dir: string): Promise<readonly DirEntry[]> {
    try {
      return await fileSystem.readdir(dir);
    } catch (error) {
      if (error instanceof FileSystemError) return [];
      throw error;
    }
  }

  /** Installed = the version directory holds the executable. */
  async function isInstalled(version: string): Promise<boolean> {
    const entries = await listOrEmpty(versionDir(version).toNative());
    return entries.some((entry) => entry.name === descriptor.executablePath);
  }

  async function newestInstalled(): Promise<string | null> {
    const entries = await listOrEmpty(pathProvider.bundlePath(descriptor.name).toNative());
    const versions = entries
      .filter((entry) => entry.isDirectory && isVersionName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => compareVersions(b, a));
    for (const version of versions) {
      if (await isInstalled(version)) return version;
    }
    return null;
  }

  /** A PATH candidate's `--version` probe: whether it runs, and as what. */
  interface SystemProbe {
    readonly runs: boolean;
    readonly version: string | null;
  }

  async function probeSystemBinary(executable: string): Promise<SystemProbe> {
    try {
      const proc = runAgentBinary(processRunner, executable, ["--version"], platform);
      const result = await proc.wait(10_000);
      if (result.running) {
        await proc.kill(1000, 1000);
        return { runs: false, version: null };
      }
      return { runs: result.exitCode === 0, version: parseAgentVersion(result.stdout) };
    } catch {
      return { runs: false, version: null };
    }
  }

  /** Whether a version speaks an API the app supports; an unknown one is given the benefit. */
  function isSupportedVersion(version: string | null): boolean {
    if (descriptor.supportedMajors === undefined || version === null) return true;
    const major = Number.parseInt(version, 10);
    return descriptor.supportedMajors.includes(major);
  }

  /** First PATH match that runs a supported version, in PATH order and candidate preference. */
  async function findSystem(): Promise<{ path: string; version: string | null } | null> {
    const caseInsensitive = platform === "win32";
    const norm = (name: string): string => (caseInsensitive ? name.toLowerCase() : name);
    for (const dir of pathEntries(deps.env, platform)) {
      const entries = await listOrEmpty(dir);
      const names = new Set(
        entries.filter((e) => e.isFile || e.isSymbolicLink).map((e) => norm(e.name))
      );
      for (const candidate of descriptor.systemCandidates) {
        if (!names.has(norm(candidate))) continue;
        const executable = new Path(dir, candidate).toNative();
        const probe = await probeSystemBinary(executable);
        if (probe.runs) {
          if (isSupportedVersion(probe.version)) {
            return { path: executable, version: probe.version };
          }
          logger
            .scoped({ path: executable })
            .warn("Ignoring system binary of an unsupported major version", {
              name: descriptor.name,
              version: probe.version,
              ...(descriptor.supportedMajors !== undefined && {
                supportedMajors: descriptor.supportedMajors.join(", "),
              }),
            });
        } else {
          logger
            .scoped({ path: executable })
            .warn("Ignoring system binary that does not run", { name: descriptor.name });
        }
      }
    }
    return null;
  }

  async function resolveChannel(channel: string): Promise<string> {
    const version = await descriptor.resolveChannel(channel, {
      fetch: (url, options) => httpClient.fetch(url, { timeout: CHANNEL_TIMEOUT_MS, ...options }),
    });
    logger.debug("Resolved channel", { name: descriptor.name, channel, version });
    return version;
  }

  function downloadVersion(version: string, onProgress?: DownloadProgressCallback): Promise<void> {
    const existing = inFlight.get(version);
    if (existing) return existing;
    const promise = (async () => {
      // A pin or a channel naming a major the app cannot talk to fails here,
      // on the setup screen, rather than running a binary on the wrong API.
      if (!isSupportedVersion(version)) {
        throw new BinaryDownloadError(
          `${descriptor.name} ${version} is not supported (supported majors: ${descriptor.supportedMajors?.join(", ")})`,
          "INVALID_VERSION"
        );
      }
      const destDir = versionDir(version).toNative();
      const request = await descriptor.downloadRequest(version, destDir, httpClient);
      await downloadBinary(request, downloadDeps, onProgress);
    })().finally(() => inFlight.delete(version));
    inFlight.set(version, promise);
    return promise;
  }

  function startBackgroundDownload(version: string): void {
    logger.info("Downloading newer version in the background", {
      name: descriptor.name,
      version,
    });
    background = downloadVersion(version)
      .then(() => {
        // Only a download-sourced binary is replaced: a pin or system install
        // resolved meanwhile is not ours to override.
        if (currentBinary?.source === "download") {
          currentBinary = downloaded(version);
        }
        logger.info("Background download complete; new workspaces use it", {
          name: descriptor.name,
          version,
        });
      })
      .catch((error: unknown) => {
        logger.warn("Background download failed", {
          name: descriptor.name,
          version,
          error: getErrorMessage(error),
        });
      })
      .finally(() => {
        background = null;
      });
  }

  /** Resolve a channel into `currentBinary` / `pending`. */
  async function resolveTracked(channel: string): Promise<void> {
    const local = await newestInstalled();
    let latest: string;
    try {
      latest = await resolveChannel(channel);
    } catch (error) {
      if (local !== null) {
        logger.warn("Could not look up the latest version; using the one downloaded", {
          name: descriptor.name,
          channel,
          version: local,
          error: getErrorMessage(error),
        });
        currentBinary = downloaded(local);
        return;
      }
      // Nothing to fall back on: let the setup screen retry the lookup.
      pending = { channel };
      return;
    }

    if (await isInstalled(latest)) {
      currentBinary = downloaded(latest);
    } else if (local !== null) {
      currentBinary = downloaded(local);
      startBackgroundDownload(latest);
    } else {
      pending = { version: latest };
    }
  }

  async function resolve(): Promise<void> {
    const setting = deps.version.get();

    if (setting !== null && !descriptor.channels.includes(setting)) {
      if (await isInstalled(setting)) {
        currentBinary = downloaded(setting);
      } else {
        pending = { version: setting };
      }
      return;
    }

    if (setting === null) {
      const system = await findSystem();
      if (system !== null) {
        logger.scoped({ path: system.path }).info("Using system install", {
          name: descriptor.name,
          version: system.version,
        });
        currentBinary = { path: system.path, source: "system", version: system.version };
        return;
      }
    }

    await resolveTracked(setting ?? descriptor.defaultChannel);
  }

  return {
    async prepare() {
      if (!resolved) {
        currentBinary = null;
        pending = null;
        await resolve();
        resolved = true;
      }
      return { needsDownload: pending !== null };
    },

    async download(onProgress) {
      if (pending === null) return;
      const version =
        "version" in pending ? pending.version : await resolveChannel(pending.channel);
      await downloadVersion(version, onProgress);
      currentBinary = downloaded(version);
      pending = null;
    },

    current: () => currentBinary,

    async seed(onProgress) {
      const setting = deps.version.get();
      const version =
        setting !== null && !descriptor.channels.includes(setting)
          ? setting
          : await resolveChannel(setting ?? descriptor.defaultChannel);
      if (await isInstalled(version)) {
        logger.info("Already downloaded", { name: descriptor.name, version });
      } else {
        await downloadVersion(version, onProgress);
      }
      return version;
    },

    bundleVersionsInUse() {
      if (!resolved) return null;
      const keep = new Set(inFlight.keys());
      if (currentBinary?.version) keep.add(currentBinary.version);
      return [...keep];
    },

    async idle() {
      while (background !== null) {
        await background;
      }
    },
  };
}

/** Thrown when a workspace launches before its agent's binary is known. */
export function binaryNotReadyError(name: string): AgentBinaryError {
  return new AgentBinaryError(
    `No ${name} binary available: it is not installed and not downloaded`
  );
}
