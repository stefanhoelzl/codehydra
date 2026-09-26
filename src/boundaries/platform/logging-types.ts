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
  | "fs" // DefaultFileSystemBoundary - filesystem operations
  | "git" // SimpleGitClient - git operations
  | "worktree" // GitWorktreeProvider - worktree operations
  | "opencode" // OpenCodeClient - OpenCode SDK
  | "claude" // ClaudeServerManager - Claude agent
  | "plugins" // PluginModule - user plugins: hooks, automations, the script runner
  | "opencode-server" // OpenCodeServerManager - opencode server lifecycle
  | "api" // IPC handlers
  | "window" // WindowManager
  | "view" // ViewManager
  | "app" // Application lifecycle
  | "ui" // Renderer UI components
  | "binary-download" // Binary download operations
  | "lifecycle" // LifecycleApi - app lifecycle
  | "api-server" // ApiServer - sidekick, `ch` and MCP connections
  | "badge" // BadgeManager - app icon badge
  | "mcp" // McpServerManager - MCP server
  | "cli" // CliModule - the ch CLI's scripts and published connection details
  | "extension" // ApiServer - extension-side logs forwarded to main
  | "ext-manager" // ExtensionModule - extension manifest loading
  | "dialog" // DialogBoundary - system dialogs
  | "menu" // MenuBoundary - application menu
  | "config" // Config - application config
  | "telemetry" // TelemetryModule + PostHogBoundary - PostHog analytics
  | "updater" // AutoUpdater - auto-update service
  | "agent" // AgentServerManager - agent lifecycle
  | "shortcut" // ShortcutController - keyboard shortcut detection
  | "presenter" // PresentationModule - ui:event intake (later: UiState presenter)
  | "dispatcher" // Dispatcher - intent dispatch pipeline
  | "state" // StateService - state.json persistence
  | "settings" // SettingsModule - settings UI
  | "help" // HelpModule - user guide (ch guide, help dialog)
  | "agent-resolver" // AgentResolver - agent selection
  | "power" // AppBoundary.allowPowerSaving - sleep prevention
  | "error-report" // ErrorReportModule - crash + manual bug report
  | "auto-tagging" // AutoTaggingModule - "new" tag on background workspaces
  | "notification" // OsNotificationModule + OsNotificationBoundary - OS toasts
  | "cleanup" // CleanupModule - stale data-root sweeps
  | "lock" // LockModule - `ch lock` single-holder resources
  | "workspaces-root" // WorkspacesRootModule - where worktrees/clones live, root migration
  | "workspace-log"; // WorkspaceLogModule - a workspace's log lines in its IDE

/**
 * Context data for log entries.
 * Constrained to primitive types for serialization safety:
 * - No nested objects (prevents circular references)
 * - No functions or symbols (not serializable)
 * - null allowed for explicit "no value" cases
 */
export type LogContext = Record<string, LogValue> & {
  /** `scope.*` is reserved for the ambient {@link LogScope}; a line's own context may not use it. */
  readonly [key: `scope.${string}`]: never;
};

/** A single value in a {@link LogContext}. */
export type LogValue = string | number | boolean | null;

/**
 * Accept context built at runtime (from another process, a parsed payload) as a
 * {@link LogContext}: `scope.*` keys are dropped rather than rejected, since the
 * type cannot check what only exists at runtime.
 */
export function toLogContext(record: Readonly<Record<string, LogValue>>): LogContext {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith("scope."))
  ) as LogContext;
}

/**
 * Ambient context of a log line: who and what a line was written on behalf of.
 *
 * Not passed by the caller — the logger reads it from the {@link LogScopeStore}
 * at the moment the line is written, so a `git` line written while an intent
 * runs names that intent without the git client knowing intents exist. The
 * dispatcher is the only writer of the ambient part; a call site adds what it
 * knows itself through {@link Logger.scoped}. Rendered as a compact block in
 * text, as the `scope` object in JSON.
 */
export interface LogScope {
  /** Id of the dispatch the line belongs to (one per dispatch, short hex). */
  readonly trace?: string;
  /** Intent type of that dispatch. */
  readonly intent?: string;
  /** Name of the project the dispatch acts on. */
  readonly project?: string;
  /** Name of the workspace the dispatch acts on. */
  readonly ws?: string;
  /** Path of that workspace, when known. JSON only; the text block shows the name. */
  readonly path?: string;
  /** Where the work entered the app (cli, mcp, sidekick, ui, shortcut, …). */
  readonly origin?: string;
  /** The calling workspace of an API call, as `<project>/<name>`. */
  readonly caller?: string;
  /** The API operation (or channel) an API call invoked. */
  readonly api?: string;
  /** The intent module whose hook handler is running. */
  readonly module?: string;
  /** The hook point that handler runs on, or `event:<type>` for an event handler. */
  readonly hook?: string;
}

/**
 * What a call site knows about a line's scope, given to {@link Logger.scoped}.
 */
export interface LogScopeHint {
  /**
   * The workspace, or a file or directory, the line is about. Resolved when
   * the line is written against the workspaces the app has named so far: the
   * workspace itself becomes the line's `project/ws` (and no `path=` is
   * written); a path inside one becomes that workspace plus `path=` relative to
   * it; any other path is written as `path=` in full, and the line then claims
   * no workspace at all — not even an ambient one, which may belong to another
   * workspace than the one the line is about. Null: no path (a caller that has none).
   */
  readonly path?: string | null;
  /** Where the work entered the app, for lines that arrive outside any dispatch. */
  readonly origin?: string;
}

/** A workspace by name, as the log scope shows it. */
export interface LogWorkspaceName {
  readonly project: string;
  readonly ws: string;
}

/**
 * Holds the ambient {@link LogScope} for the current async execution.
 *
 * Owned by {@link Logging}; loggers read it on every line. `run` takes a
 * reader rather than a value so a writer can keep mutating what it describes
 * (the dispatcher learns a dispatch's workspace mid-flight) and every later
 * line sees the update.
 */
export interface LogScopeStore {
  /** Run `fn` with `read` as the ambient scope; everything `fn` starts inherits it. */
  run<T>(read: () => LogScope, fn: () => T): T;
  /** The ambient scope right now, or undefined outside any `run`. */
  current(): LogScope | undefined;
  /** Record a workspace's name, so a line scoped to its path can show it. */
  nameWorkspace(path: string, name: LogWorkspaceName): void;
  /**
   * The named workspace a path is, or lies inside (the deepest one), with its
   * own path; undefined when none contains it.
   */
  workspaceAt(path: string): (LogWorkspaceName & { readonly path: string }) | undefined;
}

/**
 * Log output format.
 * - "text": Human-readable text lines (default)
 * - "json": JSONL with structured context
 */
export type LogFormat = "text" | "json";

/**
 * Configuration options for the logging service.
 * Passed to `configure()` to set transport levels and filters.
 */
export interface LoggingConfigureOptions {
  readonly logLevel: LogLevel;
  readonly logFile: boolean;
  readonly logConsole: boolean;
  readonly allowedLoggers: Set<LoggerName> | undefined;
  readonly logFormat: LogFormat;
}

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

  /**
   * A logger whose lines also carry what the caller knows about their scope.
   *
   * Cheap: an object that belongs to one workspace can hold one for life, and
   * a one-off line can make one inline. Resolved at write time, so a workspace
   * named after the logger was made still shows by name.
   *
   * @example
   * ```typescript
   * const log = logger.scoped({ path: workspacePath });
   * log.debug("Hook received", { hookName });
   * ```
   */
  scoped(hint: LogScopeHint): Logger;
}

/**
 * One line as a logger wrote it, before any level or logger-name filtering:
 * what {@link Logging.onLine} listeners receive.
 */
export interface LogLine {
  readonly level: LogLevel;
  readonly logger: LoggerName;
  /** The line's full scope (ambient plus any `scoped` hint), as written. */
  readonly scope: LogScope | undefined;
  readonly message: string;
  readonly context: LogContext | undefined;
  readonly error: Error | undefined;
}

/**
 * Logging service interface for the main process.
 * Creates named loggers and manages renderer logging via IPC.
 *
 * @example
 * ```typescript
 * // In main process startup
 * const loggingService = new ElectronLog(pathProvider);
 * loggingService.configure({ logLevel: 'debug', logFile: true, logConsole: false, allowedLoggers: undefined });
 * loggingService.initialize(); // Enable renderer logging
 *
 * // Create loggers for services
 * const logger = loggingService.createLogger('git');
 * const gitClient = new SimpleGitClient(logger);
 * ```
 */
export interface Logging {
  /**
   * Create a logger with the specified name (scope).
   * The name appears in log output to identify the source.
   *
   * @param name - Logger name/scope (e.g., 'git', 'process', 'api')
   * @returns Logger instance for the named scope
   */
  createLogger(name: LoggerName): Logger;

  /**
   * Configure transport levels and logger filtering.
   * Entries logged before `configure()` are buffered and flushed on first call.
   * Can be called multiple times to reconfigure.
   *
   * @param options - Log level, console toggle, and optional logger name filter
   */
  configure(options: LoggingConfigureOptions): void;

  /**
   * Initialize the logging service.
   * Call this to enable renderer logging via IPC.
   * Must be called before renderer logs can be received.
   */
  initialize(): void;

  /**
   * The ambient scope every logger of this service merges into its lines.
   */
  readonly scope: LogScopeStore;

  /**
   * Be told of every line any logger of this service writes, at every level,
   * whatever the configured level and logger filter — they narrow the file and
   * console, not this. Called synchronously on the writing call; a listener
   * must be cheap, must not throw, and must never log (it would feed itself).
   *
   * @returns Unsubscribe
   */
  onLine(listener: (line: LogLine) => void): () => void;

  /**
   * Get the current session's log file path.
   *
   * @returns Absolute path to the session log file
   */
  getLogFilePath(): string;
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
