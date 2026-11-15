/**
 * Starting CodeHydra when `ch` finds it not running, and `ch running`.
 *
 * Every command that talks to the app goes through `connectOrStart`: when the
 * instance this `ch` belongs to is not listening, it launches the executable
 * the instance published in its state.json and waits until that instance has
 * finished starting — restored its projects — so a command that resolves the
 * caller's workspace from its directory finds it. The launched app shows its
 * window in front, like any start.
 *
 * Waiting for "ready" is only done for an app this call started. One that is
 * already up but still starting is used as it is: its own startup (a plugin's
 * workspace hook) may be what is calling `ch`, and waiting for the end of
 * startup there would wait on itself.
 *
 * Everything with an effect is injected, so the decisions here run in tests
 * without a process, a clock or a file.
 */

import { UnreachableError, type Client } from "./client";
import { DiscoveryError, type Connection, type StartupInfo } from "./discovery";
import { getErrorMessage } from "../shared/error-utils";

/** How long a started app gets to become ready before `ch` gives up. */
export const START_TIMEOUT_MS = 120_000;
/** How often state.json is read while waiting. */
export const POLL_INTERVAL_MS = 250;

export interface AutostartDeps {
  /** The published connection; throws DiscoveryError when there is none. */
  readonly connection: () => Connection;
  /** Connect; throws UnreachableError when nothing answers. */
  readonly connect: (connection: Connection) => Promise<Client>;
  /** What state.json says about starting the instance. */
  readonly startupInfo: () => StartupInfo;
  /**
   * Whether `ch` may start the app at all. False when the connection came from
   * an inherited port and token (a CodeHydra terminal, an agent): those name a
   * particular running instance, and starting another would not bring it back.
   */
  readonly canStart: boolean;
  /** Launch the app, detached from this process; rejects when it cannot be started. */
  readonly launch: (executable: string, rootOverride: string | null) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Told once when the app is being started (to say so on a terminal). */
  readonly onStarting?: () => void;
  readonly timeoutMs?: number;
}

function isUnreachable(error: unknown): boolean {
  return error instanceof DiscoveryError || error instanceof UnreachableError;
}

/** Connect to the running app, or start it and connect once it is ready. */
export async function connectOrStart(deps: AutostartDeps): Promise<Client> {
  try {
    return await deps.connect(deps.connection());
  } catch (error) {
    if (!deps.canStart || !isUnreachable(error)) throw error;
    const { executable, rootOverride } = deps.startupInfo();
    if (executable === null) throw error;

    deps.onStarting?.();
    try {
      await deps.launch(executable, rootOverride);
    } catch (launchError) {
      // Uninstalled or moved since it last ran: as unreachable as not running.
      throw new UnreachableError(
        `CodeHydra is not running and could not be started from ${executable}: ${getErrorMessage(launchError)}`
      );
    }
    return waitForReady(deps);
  }
}

async function waitForReady(deps: AutostartDeps): Promise<Client> {
  const timeoutMs = deps.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if (!deps.startupInfo().ready) continue;
    try {
      return await deps.connect(deps.connection());
    } catch (error) {
      // Ready but not answering yet (the port is written a moment after), or a
      // stale ready flag from a crash that the new start has not cleared yet.
      if (!isUnreachable(error)) throw error;
    }
  }
  throw new UnreachableError(
    `CodeHydra was started but did not finish starting within ${Math.round(timeoutMs / 1000)} seconds`
  );
}

/** What `ch running` reports. */
export interface RunningStatus {
  /** The app is listening. */
  readonly running: boolean;
  /** It has also finished starting (restored its projects). */
  readonly ready: boolean;
}

/** Whether the app is running, without ever starting it. */
export async function probeRunning(
  deps: Pick<AutostartDeps, "connection" | "connect" | "startupInfo">
): Promise<RunningStatus> {
  let client: Client;
  try {
    client = await deps.connect(deps.connection());
  } catch (error) {
    if (isUnreachable(error)) return { running: false, ready: false };
    throw error;
  }
  client.close();
  return { running: true, ready: deps.startupInfo().ready };
}

/** `ch running` as text: one word a script or a person can read. */
export function renderRunningText(status: RunningStatus): string {
  if (!status.running) return "not running";
  return status.ready ? "running" : "starting";
}
