/**
 * Type definitions for the sidekick extension's Socket.IO communication.
 *
 * The protocol is declared once in `src/shared/plugin-protocol.ts` (the same
 * declaration the CodeHydra server compiles against) and re-exported here, so
 * protocol drift between app and extension is a compile error instead of a
 * runtime failure. All imports from `src/shared` are type-only and erased at
 * build time — nothing outside this package is bundled into the extension.
 *
 * Note: This extension uses socket.io-client which is bundled with Vite in SSR mode
 * to ensure the Node.js version (using 'ws' package) is used instead of the browser
 * version (which uses native WebSocket unavailable in VS Code extension host).
 */
import type { Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from "../../../src/shared/plugin-protocol";

export type {
  ServerToClientEvents,
  ClientToServerEvents,
  PluginResult,
  CommandRequest,
  ExecuteCommandRequest,
  OpenSystemPathRequest,
  SystemPathApp,
  AgentType,
  PluginConfig,
  SetMetadataRequest,
  GetWorkspaceStatusRequest,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  WorkspaceCreateRequest,
  LogRequest,
  LogContext,
  AgentLifecycleEvent,
  AgentLifecycleRequest,
  NotificationSeverity,
  ShowNotificationRequest,
  ShowNotificationResponse,
  StatusBarUpdateRequest,
  StatusBarDisposeRequest,
  QuickPickItem,
  ShowQuickPickRequest,
  ShowQuickPickResponse,
  ShowInputBoxRequest,
  ShowInputBoxResponse,
} from "../../../src/shared/plugin-protocol";

export type {
  WorkspaceStatus,
  Workspace,
  InitialPrompt,
  AgentSession,
} from "../../../src/shared/api/types";

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
