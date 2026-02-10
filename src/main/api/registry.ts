/**
 * API Registry Implementation.
 * Provides method registration, event emission, and IPC handler auto-generation.
 */

import type { IpcMainInvokeEvent } from "electron";
import type {
  IApiRegistry,
  MethodPath,
  MethodHandler,
  RegistrationOptions,
} from "./registry-types";
import { ALL_METHOD_PATHS } from "./registry-types";
import type { ICodeHydraApi, ApiEvents, Unsubscribe } from "../../shared/api/interfaces";
import { SILENT_LOGGER, type Logger } from "../../services/logging";
import type { IpcLayer } from "../../services/platform/ipc";

// Generic handler type to avoid complex variance issues
type AnyHandler = (payload: unknown) => Promise<unknown>;

// Event handler set type
type EventHandlerSet<E extends keyof ApiEvents> = Set<ApiEvents[E]>;

/**
 * Options for creating an ApiRegistry.
 */
export interface ApiRegistryOptions {
  /** Logger for registry operations */
  readonly logger?: Logger;
  /** IPC layer for handler registration (optional - if not provided, IPC registration is disabled) */
  readonly ipcLayer?: IpcLayer;
}

/**
 * API Registry implementation.
 * Manages method registration, event subscription, and IPC handler lifecycle.
 */
export class ApiRegistry implements IApiRegistry {
  // Method storage - using AnyHandler to avoid generic variance issues
  private readonly methods = new Map<MethodPath, AnyHandler>();

  // Type-safe event listeners - each event key maps to a set of handlers
  private readonly listeners = new Map<keyof ApiEvents, Set<unknown>>();

  // Registered IPC channels for cleanup
  private readonly registeredChannels: string[] = [];

  // Logger for registry operations
  private readonly logger: Logger;

  // IPC layer for handler registration
  private readonly ipcLayer: IpcLayer | undefined;

  // Track disposed state for idempotent cleanup
  private disposed = false;

  constructor(options?: ApiRegistryOptions) {
    this.logger = options?.logger ?? SILENT_LOGGER;
    this.ipcLayer = options?.ipcLayer;
  }

  /**
   * Register an API method.
   * @throws Error if registry is disposed
   * @throws Error if path is already registered
   */
  register<P extends MethodPath>(
    path: P,
    handler: MethodHandler<P>,
    options?: RegistrationOptions
  ): void {
    if (this.disposed) {
      throw new Error("Cannot register on disposed registry");
    }

    // Prevent duplicate registration
    if (this.methods.has(path)) {
      throw new Error(`Method already registered: ${path}`);
    }

    // Store handler
    // Cast is safe: MethodHandler<P> always has the shape (payload: SomePayload) => Promise<SomeResult>,
    // which is a subtype of AnyHandler = (payload: unknown) => Promise<unknown>.
    // The type system ensures at registration time that handler matches the expected signature for path P.
    this.methods.set(path, handler as AnyHandler);

    // Auto-register IPC handler if channel provided and IPC layer is available
    if (options?.ipc && this.ipcLayer) {
      const channel = options.ipc;
      const ipcHandler = async (_event: IpcMainInvokeEvent, payload: unknown): Promise<unknown> => {
        // Convert undefined/null to empty object for handlers expecting EmptyPayload.
        // Cast to AnyHandler is safe: we already stored the handler above with the same cast,
        // and the IPC handler receives the payload from the renderer which matches the expected type.
        return (handler as AnyHandler)(payload ?? {});
      };
      this.ipcLayer.handle(channel, ipcHandler);
      this.registeredChannels.push(channel);
      this.logger.debug("Registered IPC handler", { path, channel });
    }
  }

  /**
   * Emit an event to all subscribers.
   * Errors in handlers are caught and logged, not propagated.
   */
  emit<E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void {
    // Cast is safe: listeners.get(event) returns handlers registered via on<E>(),
    // which ensures all handlers in the set have the correct ApiEvents[E] type.
    const handlers = this.listeners.get(event) as EventHandlerSet<E> | undefined;
    if (!handlers) return;

    // Iterate over a copy to allow unsubscribe during emit
    for (const handler of [...handlers]) {
      // Skip if disposed during iteration
      if (this.disposed) break;

      try {
        // Cast to ApiEvents[E] is safe: we only store handlers with matching types via on<E>().
        // The `as never` for payload is a TypeScript variance workaround - the payload type
        // is correctly constrained by Parameters<ApiEvents[E]>[0] at the call site.
        (handler as ApiEvents[E])(payload as never);
      } catch (error) {
        this.logger.error(
          "Event handler error",
          { event },
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Subscribe to an event.
   * @returns Unsubscribe function
   */
  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe {
    // Cast is safe: we store handlers by event key, and each key E maps to handlers of type ApiEvents[E].
    // The Map uses Set<unknown> internally for storage flexibility, but access is type-safe through
    // the generic E parameter which constrains both get() and add() operations.
    let handlers = this.listeners.get(event) as EventHandlerSet<E> | undefined;
    if (!handlers) {
      handlers = new Set<ApiEvents[E]>();
      // Cast to Set<unknown> is safe: we're storing a typed Set<ApiEvents[E]>, and all access
      // goes through type-safe methods that cast back to the correct type.
      this.listeners.set(event, handlers as Set<unknown>);
    }
    handlers.add(handler);

    return () => {
      handlers?.delete(handler);
    };
  }

  /**
   * Get the typed public API interface.
   * @throws Error if not all methods are registered
   */
  getInterface(): ICodeHydraApi {
    // Verify all methods are registered
    this.verifyComplete();

    // Helper to get typed handler.
    // Cast is safe because:
    // 1. verifyComplete() ensures all paths in ALL_METHOD_PATHS are registered
    // 2. register<P>() ensures each path P has a handler of type MethodHandler<P>
    // 3. Therefore, methods.get(path) returns the correctly typed handler for that path
    const get = <P extends MethodPath>(path: P): MethodHandler<P> =>
      this.methods.get(path) as MethodHandler<P>;

    // Build facade that converts positional args to payload objects
    return {
      projects: {
        open: (path) => get("projects.open")({ path }),
        close: (projectId, options) => get("projects.close")({ projectId, ...options }),
        clone: (url) => get("projects.clone")({ url }),
        list: () => get("projects.list")({}),
        get: (projectId) => get("projects.get")({ projectId }),
        fetchBases: (projectId) => get("projects.fetchBases")({ projectId }),
      },
      workspaces: {
        create: (projectId, name, base, options) =>
          get("workspaces.create")({ projectId, name, base, ...options }),
        remove: (projectId, workspaceName, options) =>
          get("workspaces.remove")({
            projectId,
            workspaceName,
            ...options,
          }),
        get: (projectId, workspaceName) => get("workspaces.get")({ projectId, workspaceName }),
        getStatus: (projectId, workspaceName) =>
          get("workspaces.getStatus")({ projectId, workspaceName }),
        getAgentSession: (projectId, workspaceName) =>
          get("workspaces.getAgentSession")({ projectId, workspaceName }),
        restartAgentServer: (projectId, workspaceName) =>
          get("workspaces.restartAgentServer")({ projectId, workspaceName }),
        setMetadata: (projectId, workspaceName, key, value) =>
          get("workspaces.setMetadata")({ projectId, workspaceName, key, value }),
        getMetadata: (projectId, workspaceName) =>
          get("workspaces.getMetadata")({ projectId, workspaceName }),
        executeCommand: (projectId, workspaceName, command, args) =>
          get("workspaces.executeCommand")({
            projectId,
            workspaceName,
            command,
            ...(args !== undefined && { args }),
          }),
      },
      ui: {
        selectFolder: () => get("ui.selectFolder")({}),
        getActiveWorkspace: () => get("ui.getActiveWorkspace")({}),
        switchWorkspace: (projectId, workspaceName, focus) =>
          get("ui.switchWorkspace")({
            projectId,
            workspaceName,
            ...(focus !== undefined && { focus }),
          }),
        setMode: (mode) => get("ui.setMode")({ mode }),
      },
      lifecycle: {
        quit: () => get("lifecycle.quit")({}),
      },
      on: this.on.bind(this),
      dispose: this.dispose.bind(this),
    };
  }

  /**
   * Verify all methods are registered.
   * @throws Error if any methods are missing
   */
  private verifyComplete(): void {
    const missing = ALL_METHOD_PATHS.filter((p) => !this.methods.has(p));
    if (missing.length > 0) {
      throw new Error(`Missing method registrations: ${missing.join(", ")}`);
    }
  }

  /**
   * Cleanup all subscriptions and IPC handlers.
   * Safe to call multiple times (idempotent).
   */
  async dispose(): Promise<void> {
    // Idempotent - safe to call twice
    if (this.disposed) return;
    this.disposed = true;

    // Clean up IPC handlers (continue even if one fails)
    if (this.ipcLayer) {
      for (const channel of this.registeredChannels) {
        try {
          this.ipcLayer.removeHandler(channel);
        } catch (error) {
          this.logger.error("IPC cleanup error", {}, error instanceof Error ? error : undefined);
        }
      }
    }
    this.registeredChannels.length = 0;

    // Clear listeners
    this.listeners.clear();

    // Clear methods
    this.methods.clear();
  }
}
