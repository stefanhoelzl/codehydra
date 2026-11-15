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

/**
 * The file a running instance publishes its connection in, in its data
 * directory. Written once by cli-module at app:start, deleted at shutdown.
 *
 * Kept apart from state.json on purpose: state.json is rewritten whenever any
 * persisted value changes, and on Windows a rename over a file another process
 * is reading fails — so a `ch` reading state.json could make the app lose an
 * unrelated write. This file is written once per launch, normally onto no file
 * at all, and then only read.
 */
export const SESSION_FILE = "session.json";

/** What {@link SESSION_FILE} holds. */
export interface SessionFile {
  /** Port the API server bound. */
  readonly port: number;
  /** Shared secret `ch` presents when connecting; fresh every launch. */
  readonly token: string;
  /** The app's process id, so a file left behind by a crash reads as "not running". */
  readonly pid: number;
}

export interface DiscoveryFs {
  readFileSync(path: string, encoding: "utf-8"): string;
  realpathSync(path: string): string;
}

/**
 * Whether a process with this id exists. A crashed app leaves its session file
 * behind; without this check `ch` would present that launch's token to
 * whatever binds the port next.
 */
export type IsProcessAlive = (pid: number) => boolean;

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
  fs: DiscoveryFs,
  isAlive: IsProcessAlive
): Connection {
  const override = env._CH_DATA_DIR || undefined;
  const dataDir = resolveDataDir(selfPath, fs, override);
  if (override === undefined) {
    const port = Number(env._CH_API_PORT);
    const token = env._CH_API_TOKEN;
    if (Number.isInteger(port) && port > 0 && token) {
      return { port, token, dataDir };
    }
  }
  return readConnection(dataDir, fs, isAlive);
}

/**
 * Read the port and token the running instance published in {@link SESSION_FILE}.
 *
 * A missing or incomplete file, or one whose process is gone, means CodeHydra
 * is not running — the same condition as a refused connection, and reported
 * the same way, because the distinction is not one a caller can act on
 * differently.
 */
export function readConnection(
  dataDir: string,
  fs: DiscoveryFs,
  isAlive: IsProcessAlive
): Connection {
  const sessionPath = join(dataDir, SESSION_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    throw new DiscoveryError(`CodeHydra does not appear to be running (no ${sessionPath}).`);
  }

  let session: Partial<Record<keyof SessionFile, unknown>>;
  try {
    session = JSON.parse(raw) as Partial<Record<keyof SessionFile, unknown>>;
  } catch {
    throw new DiscoveryError(`Could not read ${sessionPath}: it is not valid JSON.`);
  }

  const { port, token, pid } = session;
  if (
    typeof port !== "number" ||
    port <= 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof pid !== "number"
  ) {
    throw new DiscoveryError(
      `CodeHydra does not appear to be running (no connection details in ${sessionPath}).`
    );
  }

  // Left behind by a launch that crashed: its port may belong to anyone now.
  if (!isAlive(pid)) {
    throw new DiscoveryError(
      `CodeHydra does not appear to be running (${sessionPath} is from a process that has exited).`
    );
  }

  return { port, token, dataDir };
}
