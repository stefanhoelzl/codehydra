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
export const STATE_PORT_KEY = "plugin.port";
export const STATE_TOKEN_KEY = "plugin.token";

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

  // A zero port is the sentinel the app writes when the plugin server is not
  // running, and is as good as absent from here.
  if (typeof port !== "number" || port <= 0 || typeof token !== "string" || token.length === 0) {
    throw new DiscoveryError(
      `CodeHydra does not appear to be running (no connection details in ${statePath}).`
    );
  }

  return { port, token, dataDir };
}
