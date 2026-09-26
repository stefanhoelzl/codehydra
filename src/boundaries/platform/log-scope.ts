/**
 * Ambient log scope: the store loggers read, a logger scoped by its call site,
 * and how a scope is rendered.
 *
 * See {@link LogScope} for what a scope carries and who writes it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as nodePath from "node:path";
import { Path } from "../../utils/path/path";
import type {
  LogContext,
  Logger,
  LogScope,
  LogScopeHint,
  LogScopeStore,
  LogWorkspaceName,
} from "./logging-types";

/** A path in the one form the index compares by, or undefined if it is not an absolute path. */
function normalize(path: string): Path | undefined {
  try {
    return new Path(path);
  } catch {
    return undefined;
  }
}

/**
 * {@link LogScopeStore} over `AsyncLocalStorage`: a scope set with `run` follows
 * every callback, promise and timer started inside it.
 */
export class AsyncLogScopeStore implements LogScopeStore {
  private readonly storage = new AsyncLocalStorage<() => LogScope>();
  /** Normalized workspace path → its name. */
  private readonly names = new Map<string, LogWorkspaceName>();

  run<T>(read: () => LogScope, fn: () => T): T {
    return this.storage.run(read, fn);
  }

  current(): LogScope | undefined {
    return this.storage.getStore()?.();
  }

  nameWorkspace(path: string, name: LogWorkspaceName): void {
    const normalized = normalize(path);
    if (normalized) this.names.set(normalized.toString(), name);
  }

  workspaceAt(path: string): (LogWorkspaceName & { readonly path: string }) | undefined {
    let at = normalize(path);
    while (at) {
      const key = at.toString();
      const name = this.names.get(key);
      if (name) return { ...name, path: key };
      // Walked by string, not `Path.dirname`: the top is `/` on POSIX but `c:` on
      // Windows, which is no absolute path and which `Path` would throw on.
      const parent = nodePath.posix.dirname(key);
      at = parent === key ? undefined : normalize(parent);
    }
    return undefined;
  }
}

/**
 * Format context object as key=value pairs for log message.
 *
 * @param context - Context object to format
 * @returns Formatted string like "key1=value1 key2=value2"
 */
export function formatContext(context: LogContext | undefined): string {
  if (!context) return "";
  return Object.entries(context)
    .map(([key, value]) => {
      // Handle null explicitly
      if (value === null) return `${key}=null`;
      // Booleans, numbers, and strings formatted directly
      return `${key}=${String(value)}`;
    })
    .join(" ");
}

/**
 * Render a scope as the compact block text lines carry after the logger name:
 * `[<trace> <project>/<ws> <intent>@<module>/<hook> <origin>]`.
 *
 * Positional, empty parts left out. A project without a workspace keeps its
 * slash (`codehydra/`) so it cannot be read as an origin. `caller` and `api`
 * are not part of the block — the dispatcher writes them on the root dispatch
 * line, and JSON carries every field on every line.
 *
 * @returns The block, or "" when the scope has nothing to show
 */
export function formatLogScope(scope: LogScope | undefined): string {
  if (!scope) return "";
  const parts: string[] = [];
  if (scope.trace) parts.push(scope.trace);
  if (scope.project !== undefined || scope.ws !== undefined) {
    parts.push(`${scope.project ?? ""}/${scope.ws ?? ""}`);
  }
  if (scope.intent !== undefined || scope.module !== undefined) {
    const handler =
      scope.module !== undefined
        ? `@${scope.module}${scope.hook !== undefined ? `/${scope.hook}` : ""}`
        : "";
    parts.push(`${scope.intent ?? ""}${handler}`);
  }
  if (scope.origin) parts.push(scope.origin);
  return parts.length > 0 ? `[${parts.join(" ")}]` : "";
}

/** The fields of a scope that name its workspace. */
const TARGET_KEYS: ReadonlySet<string> = new Set(["project", "ws", "path"]);

/** `name` at `root` if `path` is `root` or lies inside it. */
function containing(
  root: string,
  path: string,
  name: LogWorkspaceName
): (LogWorkspaceName & { readonly path: string }) | undefined {
  const rootPath = normalize(root);
  const target = normalize(path);
  if (!rootPath || !target) return undefined;
  return target.equals(rootPath) || target.isChildOf(rootPath)
    ? { ...name, path: rootPath.toString() }
    : undefined;
}

/**
 * Apply a call site's hint to the ambient scope, for one line.
 *
 * @returns The line's scope, and the `path` its context gains: undefined when
 *   there is no path or it is the line's workspace itself, relative to that
 *   workspace when inside it, in full otherwise
 */
export function applyScopeHint(
  store: LogScopeStore,
  hint: LogScopeHint
): { scope: LogScope; path: string | undefined } {
  const ambient: LogScope = store.current() ?? {};
  const origin = hint.origin !== undefined ? { origin: hint.origin } : {};
  if (hint.path === undefined || hint.path === null) {
    return { scope: { ...ambient, ...origin }, path: undefined };
  }

  // The ambient workspace counts as named even before the index has it: it is
  // the one the dispatch this line runs for is about.
  const workspace =
    store.workspaceAt(hint.path) ??
    (ambient.path !== undefined && ambient.project !== undefined && ambient.ws !== undefined
      ? containing(ambient.path, hint.path, { project: ambient.project, ws: ambient.ws })
      : undefined);

  // The ambient scope without its target: the hint decides the line's workspace.
  const rest = Object.fromEntries(
    Object.entries(ambient).filter(([key]) => !TARGET_KEYS.has(key))
  ) as LogScope;
  if (workspace === undefined) {
    // About no workspace we know — and possibly about another one than the
    // ambient scope's, so claim none.
    return { scope: { ...rest, ...origin }, path: hint.path };
  }
  const target = normalize(hint.path)!.toString();
  return {
    scope: {
      ...rest,
      project: workspace.project,
      ws: workspace.ws,
      path: workspace.path,
      ...origin,
    },
    path: target === workspace.path ? undefined : target.slice(workspace.path.length + 1),
  };
}

/**
 * A logger that adds its call site's {@link LogScopeHint} to every line: the
 * implementation behind {@link Logger.scoped}.
 */
export class ScopedLogger implements Logger {
  constructor(
    private readonly inner: Logger,
    private readonly store: LogScopeStore,
    private readonly hint: LogScopeHint
  ) {}

  private write(context: LogContext | undefined, emit: (context?: LogContext) => void): void {
    const { scope, path } = applyScopeHint(this.store, this.hint);
    const merged =
      path === undefined || context?.path !== undefined
        ? context
        : ({ path, ...context } as LogContext);
    this.store.run(
      () => scope,
      () => emit(merged)
    );
  }

  silly(message: string, context?: LogContext): void {
    this.write(context, (c) => this.inner.silly(message, c));
  }

  debug(message: string, context?: LogContext): void {
    this.write(context, (c) => this.inner.debug(message, c));
  }

  info(message: string, context?: LogContext): void {
    this.write(context, (c) => this.inner.info(message, c));
  }

  warn(message: string, context?: LogContext): void {
    this.write(context, (c) => this.inner.warn(message, c));
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.write(context, (c) => this.inner.error(message, c, error));
  }

  scoped(hint: LogScopeHint): Logger {
    return new ScopedLogger(this.inner, this.store, { ...this.hint, ...hint });
  }
}
