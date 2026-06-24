/**
 * Plugin communication protocol types.
 *
 * Defines the Socket.IO event types for communication between
 * CodeHydra (server) and VS Code extensions (clients).
 */

import { z } from "zod/v4";
import type { WorkspaceStatus, Workspace, AgentSpec, AgentSession } from "./api/types";
import { METADATA_KEY_REGEX, isValidMetadataKey, agentSpecSchema } from "./api/types";

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result wrapper for all acknowledgment responses.
 * Provides a discriminated union for success/failure handling.
 */
export type PluginResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

// ============================================================================
// Validation Infrastructure
// ============================================================================

/** A string field that must be non-empty after trimming. */
function nonEmptyString(field: string) {
  return z.string().refine((value) => value.trim().length > 0, `Field '${field}' cannot be empty`);
}

/**
 * Map a zod issue to the protocol's error-message style. Custom messages from
 * enum/refine checks pass through verbatim; union messages are written without
 * the field prefix so the path can be prepended here.
 */
function formatIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) {
    return "Invalid request";
  }
  if (issue.path.length === 0) {
    return issue.code === "invalid_type" ? "Request must be an object" : issue.message;
  }
  const field = issue.path.join(".");
  if (issue.input === undefined) {
    return `Missing required field: ${field}`;
  }
  if (issue.code === "invalid_type") {
    const expected = issue.expected === "record" ? "object" : issue.expected;
    const article = expected === "object" || expected === "array" ? "an" : "a";
    return `Field '${field}' must be ${article} ${expected}`;
  }
  if (issue.code === "invalid_union") {
    return `Field '${field}' ${issue.message}`;
  }
  return issue.message;
}

/**
 * Adapt a zod schema to a validator returning the parsed (normalized) request.
 * Only the first issue is reported, matching the fail-fast style of the
 * previous hand-rolled validators.
 */
function parseWith<T>(
  schema: z.ZodType<T>
): (payload: unknown) => { valid: true; request: T } | { valid: false; error: string } {
  return (payload) => {
    const result = schema.safeParse(payload, { reportInput: true });
    return result.success
      ? { valid: true, request: result.data }
      : { valid: false, error: formatIssue(result.error.issues[0]) };
  };
}

/**
 * Adapt a zod schema to a check-only validator; callers keep using the raw
 * payload. Used where the schema's inferred output (`field?: T | undefined`)
 * is not assignable to the hand-written interface (`field?: T`) under
 * exactOptionalPropertyTypes — those schemas also carry no `satisfies` guard.
 */
function validateWith(
  schema: z.ZodType
): (payload: unknown) => { valid: true } | { valid: false; error: string } {
  const parse = parseWith(schema);
  return (payload) => {
    const result = parse(payload);
    return result.valid ? { valid: true } : result;
  };
}

// ============================================================================
// Command Types
// ============================================================================

/**
 * VS Code command request sent from server to client.
 */
export interface CommandRequest {
  /** VS Code command identifier (e.g., "workbench.action.closeSidebar") */
  readonly command: string;
  /** Optional arguments to pass to the command */
  readonly args?: readonly unknown[];
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Agent type for terminal launching.
 */
export type AgentType = "opencode" | "claude";

/**
 * Configuration sent from server to client on connection.
 * Contains all data needed for extension startup.
 */
export interface PluginConfig {
  /** True when running in development mode */
  readonly isDevelopment: boolean;
  /** Agent environment variables for terminal integration (null if agent not ready) */
  readonly env: Record<string, string> | null;
  /** Agent type for terminal launching (null if no agent configured) */
  readonly agentType: AgentType | null;
  /** True for new workspaces (reset editor layout), false for reopened (preserve layout) */
  readonly resetWorkspace: boolean;
}

// ============================================================================
// Socket.IO Event Types
// ============================================================================

/**
 * Server to Client events (CodeHydra -> Extension).
 * Used by Socket.IO for type-safe event handling.
 */
export interface ServerToClientEvents {
  /**
   * Configuration sent immediately after connection validation.
   * Used to enable development-only features (e.g., debug commands).
   *
   * @param config - Configuration object with isDevelopment flag
   */
  config: (config: PluginConfig) => void;

  /**
   * Execute a VS Code command in the connected workspace.
   *
   * @param request - The command request containing command ID and optional args
   * @param ack - Acknowledgment callback to return the result
   */
  command: (request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => void;

  /**
   * Shutdown the extension host process for workspace deletion.
   *
   * The extension should:
   * 1. Remove all workspace folders (releases file watchers)
   * 2. Send ack to confirm receipt
   * 3. Call process.exit(0) to terminate the extension host
   *
   * CodeHydra waits for socket disconnect as confirmation.
   *
   * @param ack - Acknowledgment callback to confirm shutdown received
   */
  shutdown: (ack: (result: PluginResult<void>) => void) => void;

  /**
   * Show a notification in VS Code.
   */
  "ui:showNotification": (
    request: ShowNotificationRequest,
    ack: (result: PluginResult<ShowNotificationResponse>) => void
  ) => void;

  /**
   * Create or update a status bar item.
   */
  "ui:statusBarUpdate": (
    request: StatusBarUpdateRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;

  /**
   * Dispose a status bar item.
   */
  "ui:statusBarDispose": (
    request: StatusBarDisposeRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;

  /**
   * Show a quick pick list.
   */
  "ui:showQuickPick": (
    request: ShowQuickPickRequest,
    ack: (result: PluginResult<ShowQuickPickResponse>) => void
  ) => void;

  /**
   * Show an input box.
   */
  "ui:showInputBox": (
    request: ShowInputBoxRequest,
    ack: (result: PluginResult<ShowInputBoxResponse>) => void
  ) => void;
}

// ============================================================================
// API Request Types
// ============================================================================

/**
 * Request payload for setting workspace metadata.
 */
export interface SetMetadataRequest {
  /** Metadata key (must match METADATA_KEY_REGEX) */
  readonly key: string;
  /** Metadata value (string to set, null to delete) */
  readonly value: string | null;
}

/**
 * Request payload for executing a VS Code command.
 */
export interface ExecuteCommandRequest {
  /** VS Code command identifier (e.g., "workbench.action.files.save") */
  readonly command: string;
  /** Optional arguments to pass to the command */
  readonly args?: readonly unknown[];
}

const executeCommandRequestSchema = z.object({
  command: nonEmptyString("command"),
  args: z.array(z.unknown()).optional(),
});

/**
 * Runtime validation for ExecuteCommandRequest.
 * Validates that command is a non-empty string and args is an array if present.
 */
export const validateExecuteCommandRequest = validateWith(executeCommandRequestSchema);

/**
 * The action to perform on a system path.
 * - "explorer": show in system file manager
 * - "default": open with default application
 */
export type SystemPathApp = "default" | "explorer";

/**
 * Request payload for opening a path via the OS desktop.
 */
export interface OpenSystemPathRequest {
  /** "explorer" = show in file manager, "default" = open with default app */
  readonly app: SystemPathApp;
  /** Absolute path to the file or folder */
  readonly path: string;
}

const openSystemPathRequestSchema = z.object({
  app: z.enum(["default", "explorer"], {
    error: "Field 'app' must be 'default' or 'explorer'",
  }),
  path: nonEmptyString("path"),
}) satisfies z.ZodType<OpenSystemPathRequest>;

/**
 * Runtime validation for OpenSystemPathRequest.
 * Validates that app is a valid action and path is a non-empty string.
 */
export const validateOpenSystemPathRequest = validateWith(openSystemPathRequestSchema);

/**
 * Request payload for deleting a workspace.
 */
export interface DeleteWorkspaceRequest {
  /** If true, keep the git branch after deleting the worktree. Default: false */
  readonly keepBranch?: boolean | undefined;
}

/**
 * Response for workspace deletion.
 */
export interface DeleteWorkspaceResponse {
  /** True if deletion was started (deletion is async) */
  readonly started: boolean;
}

/**
 * Request payload for creating a workspace.
 */
export interface WorkspaceCreateRequest {
  /** Name for the new workspace (becomes branch name) */
  readonly name: string;
  /** Base branch to create the workspace from */
  readonly base: string;
  /** Optional agent spec: prompt + backend-specific launch config. */
  readonly agent?: AgentSpec;
  /** If true, steal focus from current workspace. If false, don't steal focus but still
   *  switch when no workspace is active. Default: switch (undefined treated as true). */
  readonly stealFocus?: boolean;
}

const workspaceCreateRequestSchema = z.object({
  name: nonEmptyString("name"),
  base: nonEmptyString("base"),
  agent: z
    .unknown()
    .refine(
      (value) => agentSpecSchema.safeParse(value).success,
      "Field 'agent' must be a valid agent spec ({ type, prompt?, ... })"
    )
    .optional(),
  stealFocus: z.boolean().optional(),
});

/**
 * Runtime validation for WorkspaceCreateRequest.
 * Validates structure and required fields. The optional agent spec is checked
 * against agentSpecSchema, keeping this path in sync with the intent contract.
 */
export const validateWorkspaceCreateRequest = validateWith(workspaceCreateRequestSchema);

const setMetadataRequestSchema = z.object({
  key: z
    .string()
    .refine((key) => key.length > 0, "Field 'key' cannot be empty")
    .refine(isValidMetadataKey, `Invalid key format: must match ${METADATA_KEY_REGEX.toString()}`),
  value: z.union([z.string(), z.null()], { error: "must be a string or null" }),
}) satisfies z.ZodType<SetMetadataRequest>;

/**
 * Runtime validation for SetMetadataRequest.
 * Validates structure and key format against METADATA_KEY_REGEX.
 */
export const validateSetMetadataRequest = validateWith(setMetadataRequestSchema);

const deleteWorkspaceRequestSchema = z
  .object({ keepBranch: z.boolean().optional() })
  .nullish()
  .transform((value): DeleteWorkspaceRequest => value ?? {});

/**
 * Runtime validation for DeleteWorkspaceRequest.
 * Accepts undefined/null (optional request) and normalizes it to {}.
 */
export const validateDeleteWorkspaceRequest = parseWith(deleteWorkspaceRequestSchema);

/**
 * Request to get workspace status.
 *
 * Optional refresh flag triggers a remote fetch before reading status, so
 * unmerged-commit counts reflect server-merged branches. Best-effort.
 */
export interface GetWorkspaceStatusRequest {
  readonly refresh?: boolean;
}

const getWorkspaceStatusRequestSchema = z
  .object({ refresh: z.boolean().optional() })
  .nullish()
  .transform(
    (value): GetWorkspaceStatusRequest =>
      value?.refresh === undefined ? {} : { refresh: value.refresh }
  );

/**
 * Runtime validation for GetWorkspaceStatusRequest.
 * Accepts undefined/null (optional request) and normalizes it to {}.
 */
export const validateGetWorkspaceStatusRequest = parseWith(getWorkspaceStatusRequestSchema);

// ============================================================================
// UI Request/Response Types
// ============================================================================

/**
 * Notification severity level.
 */
export type NotificationSeverity = "info" | "warning" | "error";

/**
 * Request to show a notification in VS Code.
 */
export interface ShowNotificationRequest {
  readonly severity: NotificationSeverity;
  readonly message: string;
  readonly actions?: readonly string[] | undefined;
}

/**
 * Response from a notification interaction.
 */
export interface ShowNotificationResponse {
  readonly action: string | null;
}

/**
 * Request to create or update a status bar item.
 */
export interface StatusBarUpdateRequest {
  readonly id: string;
  readonly text: string;
  readonly tooltip?: string | undefined;
  readonly command?: string | undefined;
  readonly color?: string | undefined;
}

/**
 * Request to dispose a status bar item.
 */
export interface StatusBarDisposeRequest {
  readonly id: string;
}

/**
 * A single item in a quick pick list.
 */
export interface QuickPickItem {
  readonly label: string;
  readonly description?: string | undefined;
  readonly detail?: string | undefined;
}

/**
 * Request to show a quick pick list.
 */
export interface ShowQuickPickRequest {
  readonly items: readonly QuickPickItem[];
  readonly title?: string | undefined;
  readonly placeholder?: string | undefined;
}

/**
 * Response from a quick pick selection.
 */
export interface ShowQuickPickResponse {
  readonly selected: string | null;
}

/**
 * Request to show an input box.
 */
export interface ShowInputBoxRequest {
  readonly title?: string | undefined;
  readonly prompt?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly value?: string | undefined;
  readonly password?: boolean | undefined;
}

/**
 * Response from an input box.
 */
export interface ShowInputBoxResponse {
  readonly value: string | null;
}

/**
 * Agent terminal lifecycle event reported by the sidekick.
 * - "open": the agent terminal was created (agent starting) → maps to WrapperStart.
 * - "close": the agent terminal was closed (agent gone) → maps to WrapperEnd / TUI detach.
 */
export type AgentLifecycleEvent = "open" | "close";

/**
 * Request payload for the api:workspace:agentLifecycle event.
 * The workspace is taken from the socket's auth, not this payload.
 */
export interface AgentLifecycleRequest {
  readonly event: AgentLifecycleEvent;
}

const agentLifecycleRequestSchema = z.object({
  event: z.enum(["open", "close"], {
    error: (issue) => `Invalid agent lifecycle event: ${String(issue.input)}`,
  }),
}) satisfies z.ZodType<AgentLifecycleRequest>;

/**
 * Runtime validation for AgentLifecycleRequest.
 */
export const validateAgentLifecycleRequest = validateWith(agentLifecycleRequestSchema);

// ============================================================================
// Socket.IO Event Types
// ============================================================================

/**
 * Client to Server events (Extension -> CodeHydra).
 * Provides workspace-scoped API methods for extensions.
 */
export interface ClientToServerEvents {
  /**
   * Get the current status of the connected workspace.
   *
   * @param ack - Acknowledgment callback with workspace status
   */
  "api:workspace:getStatus": (
    request: GetWorkspaceStatusRequest | undefined,
    ack: (result: PluginResult<WorkspaceStatus>) => void
  ) => void;

  /**
   * Get the agent session info for the connected workspace.
   *
   * @param ack - Acknowledgment callback with session info (null if not running)
   */
  "api:workspace:getAgentSession": (
    ack: (result: PluginResult<AgentSession | null>) => void
  ) => void;

  /**
   * Restart the agent server for the connected workspace, preserving the same port.
   *
   * @param ack - Acknowledgment callback with port number after restart
   */
  "api:workspace:restartAgentServer": (ack: (result: PluginResult<number>) => void) => void;

  /**
   * Get all metadata for the connected workspace.
   *
   * @param ack - Acknowledgment callback with metadata record
   */
  "api:workspace:getMetadata": (
    ack: (result: PluginResult<Record<string, string>>) => void
  ) => void;

  /**
   * Set or delete a metadata key for the connected workspace.
   *
   * @param request - The metadata key/value to set (value: null to delete)
   * @param ack - Acknowledgment callback with void result
   */
  "api:workspace:setMetadata": (
    request: SetMetadataRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;

  /**
   * Execute a VS Code command in the connected workspace.
   *
   * @param request - The command to execute with optional args
   * @param ack - Acknowledgment callback with command result
   */
  "api:workspace:executeCommand": (
    request: ExecuteCommandRequest,
    ack: (result: PluginResult<unknown>) => void
  ) => void;

  /**
   * Open a file or folder via the OS desktop.
   * "explorer" shows in file manager, "default" opens with default application.
   *
   * @param request - The app action and path
   * @param ack - Acknowledgment callback with void result
   */
  "api:workspace:openSystemPath": (
    request: OpenSystemPathRequest,
    ack: (result: PluginResult<void>) => void
  ) => void;

  /**
   * Delete the connected workspace.
   * This will terminate the OpenCode session and remove the worktree.
   *
   * @param request - Optional request with keepBranch option
   * @param ack - Acknowledgment callback with deletion started confirmation
   */
  "api:workspace:delete": (
    request: DeleteWorkspaceRequest | undefined,
    ack: (result: PluginResult<DeleteWorkspaceResponse>) => void
  ) => void;

  /**
   * Create a new workspace in the same project as the connected workspace.
   *
   * @param request - Workspace creation parameters
   * @param ack - Acknowledgment callback with the created workspace
   */
  "api:workspace:create": (
    request: WorkspaceCreateRequest,
    ack: (result: PluginResult<Workspace>) => void
  ) => void;

  /**
   * Send a structured log message to the main process.
   * This is a fire-and-forget event (no acknowledgment callback).
   *
   * The workspace context is automatically appended by the server.
   *
   * @param request - Log request with level, message, and optional context
   */
  "api:log": (request: LogRequest) => void;

  /**
   * Report an agent terminal lifecycle transition (open/close).
   * Fire-and-forget (no acknowledgment callback). The workspace context is
   * taken from the socket's auth. Drives agent status: "open" → WrapperStart,
   * "close" → WrapperEnd / TUI detach.
   *
   * @param request - The lifecycle event ("open" | "close")
   */
  "api:workspace:agentLifecycle": (request: AgentLifecycleRequest) => void;
}

/**
 * Socket metadata set from auth on connect.
 * Stored in the Socket.data property.
 */
export interface SocketData {
  /** Normalized workspace path this socket is connected from */
  workspacePath: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default timeout for command acknowledgments (milliseconds).
 * If no ack is received within this time, the command is considered failed.
 */
export const COMMAND_TIMEOUT_MS = 10_000;

// ============================================================================
// Log Types
// ============================================================================

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety.
 */
export type LogContext = Record<string, string | number | boolean | null>;

/**
 * Log request payload sent from extension to main process.
 */
export interface LogRequest {
  /** Log level (silly, debug, info, warn, error) */
  readonly level: string;
  /** Log message */
  readonly message: string;
  /** Optional structured context data */
  readonly context?: LogContext;
}

const logRequestSchema = z.object({
  // Note: levels duplicated from services/logging/types.ts because shared/ cannot import from services/.
  level: z.enum(["silly", "debug", "info", "warn", "error"], {
    error: (issue) => `Invalid log level: ${String(issue.input)}`,
  }),
  message: z.string().refine((value) => value.length > 0, "Field 'message' cannot be empty"),
  context: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()], {
        error: "must be a string, number, boolean, or null",
      })
    )
    .optional(),
});

/**
 * Runtime validation for LogRequest.
 * Validates structure, level, message, and context value types.
 */
export const validateLogRequest = validateWith(logRequestSchema);
