/**
 * The Socket.IO wire, and the three kinds of client that ride it.
 *
 * One connection, but not one adapter: a sidekick extension, the `ch` CLI and
 * the stdio MCP shim each get their own mapping and their own input shaping,
 * selected by the client kind declared in the handshake.
 *
 * They also differ in how operations are addressed:
 *
 * - `sidekick` reaches operations through the historical channel names
 *   (`api:workspace:getStatus`, …). Those are a published contract that
 *   third-party extensions call, so they are kept exactly as they are.
 * - `cli` and `mcp` address operations by their registry name
 *   (`api:operation:workspace.status`). New clients have no legacy to preserve,
 *   and keeping them off the extension-facing names means the compatibility
 *   surface never has to grow for them.
 *
 * Either way this is a generic loop with no per-operation code.
 */

import { OperationRegistry } from "../registry";
import { PLUGIN_MAP, type PluginMapping } from "./plugin-map";
import { MCP_MAP } from "./mcp-map";
import { CLI_MAP } from "./cli-map";
import { DESCRIBE_CHANNEL, describe, type DescribeTarget } from "./describe";
import type { InputShaping } from "../registry";
import { ApiError, categoryOf } from "../errors";
import type { OperationContext } from "../types";
import type { WorkspacePath } from "../../intents/contract";
import type { OperationName } from "../names";
import type { Logger } from "../../boundaries/platform/logging-types";
import { getErrorMessage } from "../../shared/error-utils";

/** Result wrapper the plugin protocol acknowledges every command with. */
export type PluginResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

/**
 * The slice of a Socket.IO socket this adapter needs.
 *
 * Narrowed to one method so the adapter can be driven directly in tests without
 * standing up a real server, and so it does not depend on Socket.IO's generics.
 */
export interface AdapterSocket {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** Which kind of client a connection belongs to. Declared in the handshake. */
export type ClientKind = "sidekick" | "cli" | "mcp";

/** Prefix new clients address operations by, keyed on the registry name. */
export const OPERATION_CHANNEL_PREFIX = "api:operation:";

export interface PluginAdapterOptions {
  readonly socket: AdapterSocket;
  readonly registry: OperationRegistry;
  /** Workspace this connection is scoped to, or null for a workspace-less client. */
  readonly workspacePath: WorkspacePath | null;
  /** Directory the client is running in, when it is a shell that has one. */
  readonly cwd?: string | null;
  readonly logger: Logger;
  readonly kind: ClientKind;
  /** Channel mapping override. Injectable so tests can drive the loop directly. */
  readonly map?: Readonly<Record<string, PluginMapping | null>>;
}

/** One mountable operation: where it answers, and how its input is shaped. */
interface Mount {
  readonly name: OperationName;
  readonly channel: string;
  readonly shaping: InputShaping;
  readonly fireAndForget: boolean;
}

/**
 * What this client kind can call, and where.
 *
 * A `null` in a map means the operation is deliberately absent for that client,
 * which is how the split notify/status-bar/ask forms stay off the wire and how
 * the one event stays sidekick-only.
 */
function mountsFor(
  kind: ClientKind,
  override: Readonly<Record<string, PluginMapping | null>> | undefined
): readonly Mount[] {
  if (override !== undefined || kind === "sidekick") {
    return Object.entries(override ?? PLUGIN_MAP)
      .filter(([, mapping]) => mapping !== null)
      .map(([name, mapping]) => ({
        name: name as OperationName,
        channel: mapping!.channel,
        shaping: mapping!,
        fireAndForget: mapping!.fireAndForget === true,
      }));
  }

  return Object.entries(kind === "cli" ? CLI_MAP : MCP_MAP)
    .filter(([, mapping]) => mapping !== null)
    .map(([name, mapping]) => ({
      name: name as OperationName,
      channel: `${OPERATION_CHANNEL_PREFIX}${name}`,
      shaping: mapping!,
      // Never for these clients: both are short-lived enough, or care enough
      // about the outcome, that a lost frame would be reported as success.
      fireAndForget: false,
    }));
}

/**
 * Split Socket.IO's variadic call into a request and an optional ack.
 *
 * Channels differ in whether they carry a payload — several take none and are
 * emitted as `socket.emit(channel, ack)` — so the ack is identified by being the
 * trailing function rather than by argument position.
 */
function splitArgs(args: readonly unknown[]): {
  request: unknown;
  ack?: (result: PluginResult<unknown>) => void;
} {
  const last = args[args.length - 1];
  if (typeof last === "function") {
    return {
      request: args.length > 1 ? args[0] : undefined,
      ack: last as (result: PluginResult<unknown>) => void,
    };
  }
  return { request: args[0] };
}

export function attachPluginAdapter(options: PluginAdapterOptions): void {
  const { socket, registry, workspacePath, logger, kind, map } = options;
  const ctx: OperationContext = { workspacePath, cwd: options.cwd ?? null };

  // Describe is adapter infrastructure rather than an operation: it is how an
  // out-of-process client learns what exists, so it is mounted here rather than
  // being an entry the registry would have to know an adapter for.
  socket.on(DESCRIBE_CHANNEL, (...args: unknown[]) => {
    const { request, ack } = splitArgs(args);
    const target = (request as { target?: DescribeTarget } | undefined)?.target;
    if (target !== "mcp" && target !== "cli") {
      ack?.({ success: false, error: `describe: target must be "mcp" or "cli"` });
      return;
    }
    try {
      ack?.({ success: true, data: describe(registry, target) });
    } catch (error: unknown) {
      ack?.({ success: false, error: getErrorMessage(error) });
    }
  });

  for (const mount of mountsFor(kind, map)) {
    const entry = registry.find(mount.name);
    if (entry === undefined) {
      // A mapping naming an operation the registry does not hold is a wiring
      // bug. Skipping costs one channel; throwing would cost the connection.
      logger.error("Mapped operation is missing from the registry", {
        operation: mount.name,
        channel: mount.channel,
      });
      continue;
    }

    socket.on(mount.channel, (...args: unknown[]) => {
      const { request, ack } = splitArgs(args);

      logger.debug("API call", { event: mount.channel, workspace: workspacePath });

      void registry
        .invoke(entry, ctx, request ?? {}, mount.shaping)
        .then((data) => {
          ack?.({ success: true, data });
        })
        .catch((error: unknown) => {
          const message = getErrorMessage(error);
          // Only a genuine operation failure is an app fault. A malformed
          // request, and a workspace command run where there is no workspace,
          // are both conditions of the caller's own making — `ch ws status` from
          // outside a worktree is a normal thing to do and answers with exit 4.
          // Logging those at error level would put a fault in the log, and in
          // every bug report, for something working as designed.
          const level = categoryOf(error) === "failed" ? "error" : "warn";
          logger[level]("API call failed", {
            event: mount.channel,
            workspace: workspacePath,
            error: message,
          });
          ack?.({ success: false, error: message });
        })
        // Only reachable if ack() itself throws; the caller is gone either way.
        .catch(() => {});
    });
  }
}

/** Re-exported so callers can narrow on the category without importing errors. */
export { ApiError };
