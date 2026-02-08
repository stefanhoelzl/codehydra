/**
 * Dispatcher — single entry point for the intent-operation pipeline.
 *
 * Orchestrates: interceptor pipeline → operation resolution → hook injection → execute → emit events.
 * Events are emitted inline when `ctx.emit()` is called during operation execution.
 */

import type { Intent, IntentResult, DomainEvent } from "./types";
import type { Operation, OperationContext, DispatchFn } from "./operation";
import type { IHookRegistry } from "./hook-registry";

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
}

// =============================================================================
// Dispatcher Implementation
// =============================================================================

export class Dispatcher implements IDispatcher {
  private readonly operations = new Map<string, Operation<Intent, unknown>>();
  private readonly interceptors: IntentInterceptor[] = [];
  private readonly subscribers = new Map<string, Set<EventHandler>>();

  constructor(private readonly hookRegistry: IHookRegistry) {}

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
  }

  addInterceptor(interceptor: IntentInterceptor): void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
    void this.runPipeline(intent, causation, handle);
    return handle;
  }

  private async runPipeline<I extends Intent>(
    intent: I,
    causation: readonly string[] | undefined,
    handle: IntentHandle<IntentResult<I>>
  ): Promise<void> {
    try {
      // Run interceptor pipeline
      let current: Intent | null = intent;
      for (const interceptor of this.interceptors) {
        current = await interceptor.before(current);
        if (current === null) {
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

      // Build operation context
      const ctx: OperationContext<Intent> = {
        intent: current,
        dispatch: nestedDispatch,
        emit: (event: DomainEvent) => {
          const handlers = this.subscribers.get(event.type);
          if (handlers) {
            for (const handler of handlers) {
              handler(event);
            }
          }
        },
        hooks,
        causation: causationChain,
      };

      // Execute operation
      const result = await operation.execute(ctx);
      handle.resolve(result as IntentResult<I>);
    } catch (e) {
      // Ensure accepted is signaled even if interceptor itself throws.
      // Calling signalAccepted twice is safe — Promise resolves only once.
      handle.signalAccepted(true);
      handle.reject(e);
    }
  }
}
