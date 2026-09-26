/**
 * The CLI's connection to a running CodeHydra.
 *
 * Rides the plugin server's Socket.IO wire as a distinct client kind. Unlike the
 * sidekick, a CLI connection is short-lived and non-exclusive: it never becomes
 * the workspace's registered socket, so it cannot displace the extension or
 * strand a teardown that is waiting on one.
 *
 * Every call is acknowledged, including those for operations that return
 * nothing. A short-lived process that emitted without waiting could exit before
 * the frame left the buffer, and then exit 0 would mean "queued" rather than
 * "delivered".
 */

import { io, type Socket } from "socket.io-client";
import { EVENT_CHANNEL, type ClientEvent } from "../api/events";
import { API_ERROR_CATEGORIES, type ApiErrorCategory } from "../api/errors";
import type { Connection } from "./discovery";

/** Result wrapper every command is acknowledged with. */
export type PluginResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string; readonly category?: unknown };

export class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreachableError";
  }
}

/**
 * Raised when a call is made on a connection that has already dropped.
 *
 * Distinct from other unreachable failures because the request provably never
 * left this process, so a caller that can reconnect may retry it without
 * risking running an operation twice.
 */
export class NotConnectedError extends UnreachableError {
  constructor() {
    super("The connection to CodeHydra was lost");
    this.name = "NotConnectedError";
  }
}

/** Raised when the app answered and refused the request. */
export class CallError extends Error {
  /** What kind of failure the app reported; `failed` when it did not say. */
  readonly category: ApiErrorCategory;

  constructor(message: string, category: ApiErrorCategory = "failed") {
    super(message);
    this.name = "CallError";
    this.category = category;
  }
}

/** Accept a category from the wire only if it is one we know. */
function categoryFrom(value: unknown): ApiErrorCategory {
  return API_ERROR_CATEGORIES.find((category) => category === value) ?? "failed";
}

export interface ClientOptions {
  readonly connection: Connection;
  /**
   * Which client this is. The app mounts that client's operations with its
   * defaults — `ch mcp` serves MCP's tools, so it must say it is the MCP shim,
   * or a tool the CLI does not carry (`ui_show_message`) goes unanswered and
   * one it defaults differently (`lock_take`) behaves as the CLI's. Default
   * `cli`.
   */
  readonly kind?: "cli" | "mcp";
  /** Directory the command was run from; the app resolves it to a workspace. */
  readonly cwd: string;
  /** Explicit workspace, overriding whatever cwd would resolve to. */
  readonly workspace?: string;
  /** Project to look the `workspace` name up in. */
  readonly project?: string;
  /**
   * How long to wait for the connection.
   *
   * Calls themselves have no timeout. Some legitimately take as long as they
   * take — `ch lock take` waits its turn, `ch ws ask` waits for a person — and a
   * timer here would report those as an unreachable app. A caller that wants a
   * bound sets its own (the agent's Bash tool, `timeout(1)`); an app that goes
   * away mid-call is still caught, by the socket's disconnect.
   *
   * The one thing that would hang is a call on a channel the app never mounted,
   * since nothing answers it. So callers only call what the app described:
   * `run` resolves every command against describe, and so does `ch lock run`.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface Client {
  call<T>(channel: string, request?: unknown): Promise<T>;
  /** Watch forwarded events. Returns a function that stops watching. */
  onEvent(listener: (event: ClientEvent) => void): () => void;
  close(): void;
}

/**
 * Connect, or fail with a message that says what to do about it.
 *
 * A refused connection and a stale `state.json` are the same situation from the
 * caller's side — CodeHydra is not listening — so they report identically.
 */
export async function connect(options: ClientOptions): Promise<Client> {
  const {
    connection,
    kind = "cli",
    cwd,
    workspace,
    project,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const socket: Socket = io(`http://127.0.0.1:${connection.port}`, {
    // Skip the long-polling handshake: this process may live for milliseconds,
    // and the upgrade dance would be most of its lifetime.
    transports: ["websocket"],
    auth: {
      client: kind,
      token: connection.token,
      cwd,
      ...(workspace !== undefined && { workspacePath: workspace }),
      ...(project !== undefined && { project }),
    },
    reconnection: false,
    timeout: timeoutMs,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error: Error) => {
      socket.close();
      reject(
        new UnreachableError(
          `Could not reach CodeHydra on 127.0.0.1:${connection.port}: ${error.message}`
        )
      );
    });
  });

  return {
    onEvent(listener: (event: ClientEvent) => void): () => void {
      const handler = (event: unknown) => {
        // Untrusted only in the sense that it crosses a process boundary; the
        // renderer already tolerates a payload it does not recognize.
        listener(event as ClientEvent);
      };
      socket.on(EVENT_CHANNEL, handler);
      return () => socket.off(EVENT_CHANNEL, handler);
    },

    async call<T>(channel: string, request?: unknown): Promise<T> {
      // Without reconnection a dropped socket stays dropped, and socket.io does
      // not refuse an emit on it: it buffers the packet for a reconnect that
      // never comes. "disconnect" has already fired, so nothing would ever end
      // the call. A long-lived client (`ch mcp`) meets this after a suspend.
      if (!socket.connected) throw new NotConnectedError();

      const result = await new Promise<PluginResult<T>>((resolve, reject) => {
        // With no timeout, this is the only thing that ends a call the app will
        // never answer: without it a lost app would hang the command forever.
        const onDisconnect = () => reject(new UnreachableError("CodeHydra closed the connection"));
        socket.once("disconnect", onDisconnect);

        const done = (value: PluginResult<T>) => {
          socket.off("disconnect", onDisconnect);
          resolve(value);
        };

        if (request === undefined) socket.emit(channel, done);
        else socket.emit(channel, request, done);
      });

      if (!result.success) throw new CallError(result.error, categoryFrom(result.category));
      return result.data;
    },
    close(): void {
      socket.close();
    },
  };
}
