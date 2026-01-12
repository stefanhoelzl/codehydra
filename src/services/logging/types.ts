/**
 * Logging types and interfaces.
 *
 * Provides a testable logging abstraction over electron-log with:
 * - Type-safe logger names (scopes)
 * - Constrained context type (no nested objects, functions, symbols)
 * - Interface for dependency injection
 */

/**
 * Log levels in order of verbosity (most verbose to least).
 */
export const LogLevel = {
  silly: "silly",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Valid logger names (scopes).
 * Each name corresponds to a module or subsystem in the application.
 */
export type LoggerName =
  | "process" // LoggingProcessRunner - process spawning
  | "network" // DefaultNetworkLayer - HTTP, ports
  | "fs" // DefaultFileSystemLayer - filesystem operations
  | "git" // SimpleGitClient - git operations
  | "worktree" // GitWorktreeProvider - worktree operations
  | "opencode" // OpenCodeClient - OpenCode SDK
  | "claude" // ClaudeServerManager - Claude agent
  | "code-server" // CodeServerManager - code-server process
  | "keepfiles" // KeepFilesService - .keepfiles copying
  | "opencode-server" // OpenCodeServerManager - opencode server lifecycle
  | "api" // IPC handlers
  | "window" // WindowManager
  | "view" // ViewManager
  | "app" // Application lifecycle
  | "ui" // Renderer UI components
  | "binary-download" // BinaryDownloadService - binary downloads
  | "vscode-setup" // VscodeSetupService - VS Code setup
  | "lifecycle" // LifecycleApi - app lifecycle
  | "plugin" // PluginServer - VS Code extension communication
  | "badge" // BadgeManager - app icon badge
  | "mcp" // McpServerManager - MCP server
  | "extension" // PluginServer - extension-side logs forwarded to main
  | "dialog" // DialogLayer - system dialogs
  | "menu" // MenuLayer - application menu
  | "workspace-file" // WorkspaceFileService - .code-workspace file management
  | "config"; // ConfigService - application config

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety:
 * - No nested objects (prevents circular references)
 * - No functions or symbols (not serializable)
 * - null allowed for explicit "no value" cases
 */
export type LogContext = Record<string, string | number | boolean | null>;

/**
 * Logger interface for dependency injection.
 * Services receive this interface via constructor injection.
 *
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private readonly logger: Logger) {}
 *
 *   async doWork(): Promise<void> {
 *     this.logger.debug('Starting work', { taskId: 'abc123' });
 *     try {
 *       // ... work
 *       this.logger.info('Work complete', { durationMs: 100 });
 *     } catch (err) {
 *       this.logger.error('Work failed', { taskId: 'abc123' }, err as Error);
 *     }
 *   }
 * }
 * ```
 */
export interface Logger {
  /**
   * Log a silly message (most verbose).
   * Use for per-iteration/per-scan details that would be overwhelming in normal debug output.
   */
  silly(message: string, context?: LogContext): void;

  /**
   * Log a debug message.
   * Use for detailed tracing information useful during development.
   */
  debug(message: string, context?: LogContext): void;

  /**
   * Log an info message.
   * Use for significant operations (start/stop, connections, completions).
   */
  info(message: string, context?: LogContext): void;

  /**
   * Log a warning message.
   * Use for recoverable issues or deprecated behavior.
   */
  warn(message: string, context?: LogContext): void;

  /**
   * Log an error message.
   * Use for failures that require attention.
   *
   * @param message - Human-readable error description
   * @param context - Structured context data
   * @param error - Optional Error object for stack trace inclusion
   */
  error(message: string, context?: LogContext, error?: Error): void;
}

/**
 * Logging service interface for the main process.
 * Creates named loggers and manages renderer logging via IPC.
 *
 * @example
 * ```typescript
 * // In main process startup
 * const loggingService = new ElectronLogService(buildInfo, pathProvider);
 * loggingService.initialize(); // Enable renderer logging
 *
 * // Create loggers for services
 * const logger = loggingService.createLogger('git');
 * const gitClient = new SimpleGitClient(logger);
 * ```
 */
export interface LoggingService {
  /**
   * Create a logger with the specified name (scope).
   * The name appears in log output to identify the source.
   *
   * @param name - Logger name/scope (e.g., 'git', 'process', 'api')
   * @returns Logger instance for the named scope
   */
  createLogger(name: LoggerName): Logger;

  /**
   * Initialize the logging service.
   * Call this to enable renderer logging via IPC.
   * Must be called before renderer logs can be received.
   */
  initialize(): void;

  /**
   * Dispose of the logging service.
   * Cleans up any resources (e.g., IPC handlers).
   */
  dispose(): void;
}

/**
 * Log a message at the specified level.
 * Useful when the log level is dynamic (e.g., from a switch statement).
 *
 * @param logger - The logger instance
 * @param level - The log level to use
 * @param message - The log message
 * @param context - Optional context data
 *
 * @example
 * ```typescript
 * // Instead of switch statement:
 * logAtLevel(logger, level, message, context);
 * ```
 */
export function logAtLevel(
  logger: Logger,
  level: LogLevel,
  message: string,
  context?: LogContext
): void {
  logger[level](message, context);
}
