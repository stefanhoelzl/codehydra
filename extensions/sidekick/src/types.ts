/**
 * Type definitions for the sidekick extension's Socket.IO communication.
 *
 * Note: This extension uses socket.io-client which is bundled with Vite in SSR mode
 * to ensure the Node.js version (using 'ws' package) is used instead of the browser
 * version (which uses native WebSocket unavailable in VS Code extension host).
 */
import type { Socket } from "socket.io-client";
import type {
  WorkspaceStatus,
  AgentStatus,
  Workspace,
  LogContext,
  InitialPrompt,
  OpenCodeSession,
} from "../api";

// Re-export types from api.d.ts that are used internally
export type { WorkspaceStatus, AgentStatus, Workspace, LogContext, InitialPrompt, OpenCodeSession };

// API response types
export type PluginResult<T = unknown> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

export interface CommandRequest {
  readonly command: string;
  readonly args?: readonly unknown[];
}

export interface PluginConfig {
  readonly isDevelopment: boolean;
}

export interface SetMetadataRequest {
  readonly key: string;
  readonly value: string | null;
}

export interface LogRequest {
  readonly level: "silly" | "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly context?: LogContext;
}

export interface WorkspaceCreateRequest {
  readonly name: string;
  readonly base: string;
  readonly initialPrompt?: InitialPrompt;
  readonly keepInBackground?: boolean;
}

// Socket.IO typed events
export interface ServerToClientEvents {
  config: (config: PluginConfig) => void;
  command: (request: CommandRequest, ack: (result: PluginResult) => void) => void;
  shutdown: (ack: (result: PluginResult<undefined>) => void) => void;
}

export interface ClientToServerEvents {
  "api:workspace:getStatus": (ack: (result: PluginResult<WorkspaceStatus>) => void) => void;
  "api:workspace:getMetadata": (
    ack: (result: PluginResult<Record<string, string>>) => void
  ) => void;
  "api:workspace:setMetadata": (
    request: SetMetadataRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;
  "api:workspace:getOpenCodeSession": (
    ack: (result: PluginResult<OpenCodeSession | null>) => void
  ) => void;
  "api:workspace:restartOpencodeServer": (ack: (result: PluginResult<number>) => void) => void;
  "api:workspace:executeCommand": (
    request: CommandRequest,
    ack: (result: PluginResult<unknown>) => void
  ) => void;
  "api:workspace:create": (
    request: WorkspaceCreateRequest,
    ack: (result: PluginResult<Workspace>) => void
  ) => void;
  "api:log": (request: LogRequest) => void;
}

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
