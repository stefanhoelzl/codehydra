/**
 * Dispatcher — single entry point for the intent-operation pipeline.
 *
 * Orchestrates: interceptor pipeline → operation resolution → hook injection → execute → emit events.
 * Events are emitted inline when `ctx.emit()` is called during operation execution.
 *
 * When a Logger is provided, the dispatcher logs:
 * - Intent dispatch start (info)
 * - Interceptor blocks (warn)
 * - Hook point execution with timing, module names, results, errors (debug)
 * - Hook errors (warn)
 * - Event emissions with subscriber names (info)
 * - Intent completion with timing (info)
 * - Intent failure (error)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Intent, IntentResult, DomainEvent } from "./types";
import type {
  Operation,
  OperationContext,
  DispatchFn,
  ResolvedHooks,
  HookContext,
} from "./operation";
import type { HookResult } from "./operation";
import type { IHookRegistry } from "./hook-registry";
import type { IntentModule } from "./module";
import type { Logger } from "../../../services/logging/types";

// =============================================================================
// IntentHandle
// =============================================================================

/**
 * Deferred-based thenable returned by `dispatch()`.
 *
 * - `await handle` — waits for the full operation result (thenable via `.then()`)
 * - `await handle.accepted` — resolves after interceptors: `true` if accepted, `false` if cancelled
 *
 * Backwards compatible: existing `await dispatch(intent)` unwraps via `.then()`.
 */
export class IntentHandle<T> implements PromiseLike<T> {
  readonly #result: Promise<T>;
  readonly #accepted: Promise<boolean>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly #resolveAccepted: (value: boolean) => void;

  constructor() {
    let res!: (value: T) => void;
    let rej!: (reason: unknown) => void;
    this.#result = new Promise<T>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
    this.resolve = res;
    this.reject = rej;

    let resAccepted!: (value: boolean) => void;
    this.#accepted = new Promise<boolean>((resolve) => {
      resAccepted = resolve;
    });
    this.#resolveAccepted = resAccepted;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.#result.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.#result.catch(onrejected);
  }

  get accepted(): Promise<boolean> {
    return this.#accepted;
  }

  signalAccepted(value: boolean): void {
    this.#resolveAccepted(value);
  }
}

// =============================================================================
// Interceptor
// =============================================================================

/**
 * Pre-operation policy that can modify or cancel an intent.
 * Returning null from `before()` cancels the intent.
 */
export interface IntentInterceptor {
  readonly id: string;
  readonly order?: number;
  before(intent: Intent): Promise<Intent | null>;
}

// =============================================================================
// Event Handler
// =============================================================================

/**
 * Handler for domain events emitted by operations.
 */
export type EventHandler = (event: DomainEvent) => void;

// =============================================================================
// IDispatcher Interface
// =============================================================================

/**
 * Dispatcher interface for dispatching intents and subscribing to domain events.
 */
export interface IDispatcher {
  dispatch<I extends Intent>(
    intent: I,
    causation?: readonly string[]
  ): IntentHandle<IntentResult<I>>;
  subscribe(eventType: string, handler: EventHandler): () => void;
  addInterceptor(interceptor: IntentInterceptor): void;
  registerModule(module: IntentModule): void;
}

// =============================================================================
// Dispatcher Implementation
// =============================================================================

export class Dispatcher implements IDispatcher {
  private readonly operations = new Map<string, Operation<Intent, unknown>>();
  private readonly interceptors: IntentInterceptor[] = [];
  private readonly subscribers = new Map<string, Set<EventHandler>>();
  private readonly causationContext = new AsyncLocalStorage<readonly string[]>();

  /** operationId → hookPointId → module names[] */
  private readonly hookModuleNames = new Map<string, Map<string, string[]>>();

  /** eventType → module names[] */
  private readonly eventSubscriberNames = new Map<string, string[]>();

  constructor(
    private readonly hookRegistry: IHookRegistry,
    private readonly logger?: Logger
  ) {}

  /**
   * Register an operation for a specific intent type.
   * Only one operation per intent type is allowed.
   *
   * Generic to accept operations with specific intent types. Type safety
   * is maintained by dispatch() matching intent.type to the correct operation.
   */
  registerOperation<I extends Intent, R>(intentType: string, operation: Operation<I, R>): void {
    if (this.operations.has(intentType)) {
      throw new Error(`Operation already registered for intent type: ${intentType}`);
    }
    this.operations.set(intentType, operation as unknown as Operation<Intent, unknown>);
    this.logger?.debug("register operation", { intent: intentType });
  }

  addInterceptor(interceptor: IntentInterceptor): void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  registerModule(module: IntentModule): void {
    this.logger?.debug("register module", { module: module.name });
    if (module.hooks) {
      for (const [operationId, hookPoints] of Object.entries(module.hooks)) {
        for (const [hookPointId, handler] of Object.entries(hookPoints)) {
          this.hookRegistry.register(operationId, hookPointId, handler);
          this.trackHookModule(operationId, hookPointId, module.name);
          this.logger?.silly("  hook", { module: module.name, op: operationId, hook: hookPointId });
        }
      }
    }
    if (module.events) {
      for (const [eventType, handler] of Object.entries(module.events)) {
        this.subscribe(eventType, handler);
        this.trackEventSubscriber(eventType, module.name);
        this.logger?.silly("  event", { module: module.name, event: eventType });
      }
    }
    if (module.interceptors) {
      for (const interceptor of module.interceptors) {
        this.addInterceptor(interceptor);
        this.logger?.silly("  interceptor", { module: module.name, interceptor: interceptor.id });
      }
    }
  }

  subscribe(eventType: string, handler: EventHandler): () => void {
    let handlers = this.subscribers.get(eventType);
    if (!handlers) {
      handlers = new Set<EventHandler>();
      this.subscribers.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  dispatch<I extends Intent>(
    intent: I,
    causation?: readonly string[]
  ): IntentHandle<IntentResult<I>> {
    const handle = new IntentHandle<IntentResult<I>>();
    const resolvedCausation = causation ?? this.causationContext.getStore();
    void this.runPipeline(intent, resolvedCausation, handle);
    return handle;
  }

  private trackHookModule(operationId: string, hookPointId: string, moduleName: string): void {
    let opMap = this.hookModuleNames.get(operationId);
    if (!opMap) {
      opMap = new Map<string, string[]>();
      this.hookModuleNames.set(operationId, opMap);
    }
    let names = opMap.get(hookPointId);
    if (!names) {
      names = [];
      opMap.set(hookPointId, names);
    }
    names.push(moduleName);
  }

  private trackEventSubscriber(eventType: string, moduleName: string): void {
    let names = this.eventSubscriberNames.get(eventType);
    if (!names) {
      names = [];
      this.eventSubscriberNames.set(eventType, names);
    }
    names.push(moduleName);
  }

  private createLoggedHooks(hooks: ResolvedHooks, operationId: string): ResolvedHooks {
    return {
      collect: async <T>(hookPointId: string, ctx: HookContext): Promise<HookResult<T>> => {
        const modules = this.hookModuleNames.get(operationId)?.get(hookPointId) ?? [];
        const start = performance.now();
        const result = await hooks.collect<T>(hookPointId, ctx);
        const duration = Math.round(performance.now() - start);

        this.logger!.debug("hook", {
          op: operationId,
          hook: hookPointId,
          modules: modules.join(","),
          results: result.results.length,
          errors: result.errors.length,
          ms: duration,
        });

        if (result.errors.length > 0) {
          for (const error of result.errors) {
            this.logger!.warn("hook error", {
              op: operationId,
              hook: hookPointId,
              error: error.message,
            });
          }
        }

        return result;
      },
    };
  }

  private async runPipeline<I extends Intent>(
    intent: I,
    causation: readonly string[] | undefined,
    handle: IntentHandle<IntentResult<I>>
  ): Promise<void> {
    const pipelineStart = performance.now();

    try {
      this.logger?.info("dispatch", {
        intent: intent.type,
        causation: causation?.join(" > ") ?? "",
      });

      // Run interceptor pipeline
      let current: Intent | null = intent;
      for (const interceptor of this.interceptors) {
        current = await interceptor.before(current);
        if (current === null) {
          this.logger?.warn("interceptor blocked", {
            intent: intent.type,
            interceptor: interceptor.id,
          });
          handle.signalAccepted(false);
          handle.resolve(undefined as IntentResult<I>);
          return;
        }
      }
      handle.signalAccepted(true);

      // Resolve operation
      const operation = this.operations.get(current.type);
      if (!operation) {
        throw new Error(`No operation registered for intent type: ${current.type}`);
      }

      // Build causation chain using intent type
      const causationChain = [...(causation ?? []), current.type];

      // Build dispatch function for nested dispatch
      const nestedDispatch: DispatchFn = async <NI extends Intent>(
        nestedIntent: NI,
        nestedCausation?: readonly string[]
      ): Promise<IntentResult<NI>> => {
        const mergedCausation = [...causationChain, ...(nestedCausation ?? [])];
        return await this.dispatch(nestedIntent, mergedCausation);
      };

      // Resolve hooks for this operation
      const hooks = this.hookRegistry.resolve(operation.id);
      const loggedHooks: ResolvedHooks = this.logger
        ? this.createLoggedHooks(hooks, operation.id)
        : hooks;

      // Build operation context
      const ctx: OperationContext<Intent> = {
        intent: current,
        dispatch: nestedDispatch,
        emit: (event: DomainEvent) => {
          const handlers = this.subscribers.get(event.type);
          if (handlers) {
            if (this.logger) {
              const names = this.eventSubscriberNames.get(event.type) ?? [];
              this.logger.info("emit", {
                event: event.type,
                subscribers: names.join(","),
              });
            }
            for (const handler of handlers) {
              handler(event);
            }
          }
        },
        hooks: loggedHooks,
        causation: causationChain,
      };

      // Execute operation within causation context so that any
      // dispatcher.dispatch() calls from hooks inherit the chain.
      const result = await this.causationContext.run(causationChain, () => operation.execute(ctx));

      const duration = Math.round(performance.now() - pipelineStart);
      this.logger?.info("completed", { intent: current.type, ms: duration });

      handle.resolve(result as IntentResult<I>);
    } catch (e) {
      this.logger?.error("failed", {
        intent: intent.type,
        error: e instanceof Error ? e.message : String(e),
      });
      // Ensure accepted is signaled even if interceptor itself throws.
      // Calling signalAccepted twice is safe — Promise resolves only once.
      handle.signalAccepted(true);
      handle.reject(e);
    }
  }
}
