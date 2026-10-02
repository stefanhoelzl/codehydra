/**
 * The sidekick's connection to CodeHydra's API server: the Socket.IO client,
 * the ready gate `whenReady()` waits on, request/response calls with a
 * timeout, and the fire-and-forget log channel.
 *
 * The gate opens on each valid `config` event (the server's handshake reply)
 * and closes on disconnect; deactivation rejects whoever still waits.
 */
import { io } from "socket.io-client";
import type { ApiConfig, ApiResult, LogContext, TypedSocket } from "./types";

/** Timeout for API calls in milliseconds (matches COMMAND_TIMEOUT_MS) */
const API_TIMEOUT_MS = 10000;

/**
 * A whenReady() caller. Not `Promise.withResolvers`: the extension targets
 * ES2022 (tsconfig.ext.json), whatever Node the editor's extension host runs.
 */
interface PendingReady {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ConnectionState {
  socket: TypedSocket | null;
  /** A config arrived since the last (re)connect: the ready gate is open. */
  isConnected: boolean;
  /** A config arrived at least once; later ones are reconnects. */
  hasReceivedInitialConfig: boolean;
  /** Callers of whenReady() waiting for the gate to open. */
  pendingReady: PendingReady[];
  workspacePath: string;
  apiPort: number | null;
}

const state: ConnectionState = {
  socket: null,
  isConnected: false,
  hasReceivedInitialConfig: false,
  pendingReady: [],
  workspacePath: "",
  apiPort: null,
};

/** The socket while it is connected, else null. */
export function connectedSocket(): TypedSocket | null {
  return state.socket?.connected ? state.socket : null;
}

/** Snapshot for the development "connection info" command. */
export function connectionInfo(): {
  connected: boolean;
  workspacePath: string;
  apiPort: number | null;
  socketId: string | null;
} {
  return {
    connected: state.isConnected,
    workspacePath: state.workspacePath,
    apiPort: state.apiPort,
    socketId: state.socket?.id ?? null,
  };
}

/** Resolves once connected to CodeHydra; immediately when already connected. */
export function whenReady(): Promise<void> {
  if (state.isConnected && state.socket?.connected) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    state.pendingReady.push({ resolve, reject });
  });
}

function settlePendingReady(settle: (pending: PendingReady) => void): void {
  const pending = state.pendingReady;
  state.pendingReady = [];
  for (const entry of pending) settle(entry);
}

type LogLevel = "silly" | "debug" | "info" | "warn" | "error";

function emitLog(level: LogLevel, message: string, context?: LogContext): void {
  const socket = connectedSocket();
  if (!socket) return;
  socket.emit("api:log", { level, message, context });
}

/**
 * Structured logging into CodeHydra's log. Fire-and-forget; a no-op while
 * disconnected.
 */
export const log = {
  silly(message: string, context?: LogContext): void {
    emitLog("silly", message, context);
  },
  debug(message: string, context?: LogContext): void {
    emitLog("debug", message, context);
  },
  info(message: string, context?: LogContext): void {
    emitLog("info", message, context);
  },
  warn(message: string, context?: LogContext): void {
    emitLog("warn", message, context);
  },
  error(message: string, context?: LogContext): void {
    emitLog("error", message, context);
  },
};

/**
 * Emit an API call with timeout handling.
 */
export function emitApiCall<T>(event: string, request?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = state.socket;
    if (!socket) {
      reject(new Error("Not connected to CodeHydra"));
      return;
    }

    const timeout = setTimeout(() => {
      log.warn("API call timeout", { event });
      reject(new Error(`API call timed out: ${event}`));
    }, API_TIMEOUT_MS);

    const handleResult = (result: ApiResult<T>): void => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result.data);
      } else {
        reject(new Error(result.error));
      }
    };

    // Emit with or without request based on event type
    // Socket.IO's TypedSocket requires exact event name literals for type inference.
    // This generic wrapper uses a dynamic event string, which TypeScript cannot verify
    // against the ClientToServerEvents interface at compile time.
    if (request !== undefined) {
      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate dynamic event names
      socket.emit(event, request, handleResult);
    } else {
      // @ts-expect-error Dynamic event name - TypedSocket strict typing cannot accommodate dynamic event names
      socket.emit(event, handleResult);
    }
  });
}

export interface ConnectionHandlers {
  /**
   * A valid config arrived and the ready gate is open. `isReconnect`: an
   * earlier connection already delivered one.
   */
  onConfig(config: ApiConfig, isReconnect: boolean): Promise<void>;
  /** Register the server → sidekick request handlers on the new socket. */
  register(socket: TypedSocket): void;
}

/** Connect to the API server, reconnecting for as long as the extension lives. */
export function connectToApiServer(
  port: number,
  workspacePath: string,
  handlers: ConnectionHandlers
): void {
  state.workspacePath = workspacePath;
  state.apiPort = port;

  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    auth: {
      workspacePath: workspacePath,
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
    autoConnect: false,
  }) as TypedSocket;
  state.socket = socket;

  socket.on("config", async (config: ApiConfig) => {
    if (typeof config !== "object" || config === null) {
      return;
    }
    if (typeof config.isDevelopment !== "boolean") {
      return;
    }

    state.isConnected = true;
    settlePendingReady(({ resolve }) => resolve());

    const isReconnect = state.hasReceivedInitialConfig;
    state.hasReceivedInitialConfig = true;
    await handlers.onConfig(config, isReconnect);
  });

  socket.on("connect", () => {
    log.info("Connected to ApiServer");
  });

  socket.on("disconnect", (reason) => {
    log.info("Disconnected from ApiServer", { reason });
    state.isConnected = false;
  });

  socket.on("connect_error", (err) => {
    log.error("Connection error", { error: err.message });
  });

  handlers.register(socket);

  socket.connect();
}

/** Disconnect and reset; whoever still waits in whenReady() is rejected. */
export function disconnectFromApiServer(): void {
  if (state.socket) {
    log.info("Deactivating");
    state.socket.disconnect();
    state.socket = null;
  }
  state.isConnected = false;
  state.hasReceivedInitialConfig = false;
  state.workspacePath = "";
  state.apiPort = null;
  settlePendingReady(({ reject }) => reject(new Error("Extension deactivating")));
}
