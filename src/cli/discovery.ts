/**
 * Finding the CodeHydra instance to talk to.
 *
 * `ch` ships inside an instance's data directory (`<dataRoot>/bin/ch.cjs`), so it
 * locates its own instance by resolving its own path rather than by reading the
 * environment. That works identically from a workspace terminal, from a plain
 * shell, and from a process that inherited none of CodeHydra's variables — which
 * is what lets `ch` be used from outside CodeHydra at all.
 *
 * Filesystem access is injected rather than imported so this stays testable, and
 * because the CLI is a standalone bundle that cannot pull in the app's
 * FileSystemBoundary — the same reason the agent wrapper scripts read `node:fs`
 * directly.
 */

import { dirname, join } from "node:path";

/** State keys the CLI needs. Written by cli-module at app:start. */
export const STATE_PORT_KEY = "api.port";
export const STATE_TOKEN_KEY = "api.token";
/** True once the instance has restored its projects (startup is over). */
export const STATE_READY_KEY = "api.ready";
/** What starts this instance, for autostart; null when `ch` must not start it. */
export const STATE_EXECUTABLE_KEY = "app.executable";
/** The `_CHDEV_ROOT_DIR` the instance ran under, which a launch must repeat. */
export const STATE_ROOT_OVERRIDE_KEY = "app.root-override";

export interface DiscoveryFs {
  readFileSync(path: string, encoding: "utf-8"): string;
  realpathSync(path: string): string;
}

export interface Connection {
  readonly port: number;
  readonly token: string;
  readonly dataDir: string;
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * The data directory this copy of `ch` belongs to.
 *
 * The real path is resolved first so a symlink on the user's PATH still points
 * at the instance that installed it, rather than at wherever the link lives.
 */
export function resolveDataDir(selfPath: string, fs: DiscoveryFs, override?: string): string {
  if (override !== undefined) return override;
  let resolved: string;
  try {
    resolved = fs.realpathSync(selfPath);
  } catch {
    // A missing realpath is not worth failing over: the unresolved path is
    // still right whenever no symlink is involved.
    resolved = selfPath;
  }
  // <dataRoot>/bin/ch.cjs → <dataRoot>
  return dirname(dirname(resolved));
}

/** What `ch` reads from its environment to find an instance. */
export interface ConnectionEnv {
  /** Overrides everything: the instance whose data directory this is. */
  readonly _CH_DATA_DIR?: string | undefined;
  readonly _CH_API_PORT?: string | undefined;
  readonly _CH_API_TOKEN?: string | undefined;
}

/**
 * Whether the connection comes from an inherited port and token rather than a
 * data directory — the case `chooseConnection` takes them in.
 */
export function inheritsConnection(env: ConnectionEnv): boolean {
  if (env._CH_DATA_DIR) return false;
  const port = Number(env._CH_API_PORT);
  return Number.isInteger(port) && port > 0 && Boolean(env._CH_API_TOKEN);
}

/**
 * Pick the connection: `_CH_DATA_DIR`, then `_CH_API_PORT` +
 * `_CH_API_TOKEN`, then the data directory this copy of `ch` belongs to.
 *
 * The port and token exist so `ch` and `ch mcp` can run with no state file to
 * read, as they do under OpenCode's server. `_CH_DATA_DIR` beats them because
 * it is the one deliberate choice: a shell that inherited one instance's port
 * and token can still point `ch` at another. (An instance started from inside
 * another one clears every inherited `_CH_*` at startup, so its own children
 * never carry the parent's.)
 */
export function chooseConnection(
  selfPath: string,
  env: ConnectionEnv,
  fs: DiscoveryFs
): Connection {
  const dataDir = resolveDataDir(selfPath, fs, env._CH_DATA_DIR || undefined);
  if (inheritsConnection(env)) {
    return { port: Number(env._CH_API_PORT), token: env._CH_API_TOKEN ?? "", dataDir };
  }
  return readConnection(dataDir, fs);
}

/**
 * What the instance left in state.json about starting it, and whether it has
 * finished starting. Never throws: a missing or unreadable file is an instance
 * that cannot be started from here and is not ready.
 */
export interface StartupInfo {
  /** The executable to launch; null when the instance did not publish one. */
  readonly executable: string | null;
  /** `_CHDEV_ROOT_DIR` to launch it with; null for the default data root. */
  readonly rootOverride: string | null;
  /** Whether the instance has finished starting (restored its projects). */
  readonly ready: boolean;
}

export function readStartupInfo(dataDir: string, fs: DiscoveryFs): StartupInfo {
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(dataDir, "state.json"), "utf-8"));
    if (parsed !== null && typeof parsed === "object") state = parsed as Record<string, unknown>;
  } catch {
    // Missing or mid-rename: nothing to start, not ready.
  }
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    executable: text(state[STATE_EXECUTABLE_KEY]),
    rootOverride: text(state[STATE_ROOT_OVERRIDE_KEY]),
    ready: state[STATE_READY_KEY] === true,
  };
}

/**
 * Read the port and token the running instance published.
 *
 * A missing or incomplete file means CodeHydra is not running — the same
 * condition as a refused connection, and reported the same way, because the
 * distinction is not one a caller can act on differently.
 */
export function readConnection(dataDir: string, fs: DiscoveryFs): Connection {
  const statePath = join(dataDir, "state.json");

  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    throw new DiscoveryError(`CodeHydra does not appear to be running (no ${statePath}).`);
  }

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new DiscoveryError(`Could not read ${statePath}: it is not valid JSON.`);
  }

  const port = state[STATE_PORT_KEY];
  const token = state[STATE_TOKEN_KEY];

  // A zero port is the sentinel the app writes when the API server is not
  // running, and is as good as absent from here.
  if (typeof port !== "number" || port <= 0 || typeof token !== "string" || token.length === 0) {
    throw new DiscoveryError(
      `CodeHydra does not appear to be running (no connection details in ${statePath}).`
    );
  }

  return { port, token, dataDir };
}
