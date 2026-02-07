/**
 * Dispatcher — single entry point for the intent-operation pipeline.
 *
 * Orchestrates: interceptor pipeline → operation resolution → hook injection → execute → emit events.
 * Events are collected during execution and emitted after completion.
 */

import type { Intent, IntentResult, DomainEvent } from "./types";
import type { Operation, OperationContext, DispatchFn } from "./operation";
import type { IHookRegistry } from "./hook-registry";

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
  dispatch<I extends Intent>(intent: I, causation?: readonly string[]): Promise<IntentResult<I>>;
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
   */
  registerOperation(intentType: string, operation: Operation<Intent, unknown>): void {
    if (this.operations.has(intentType)) {
      throw new Error(`Operation already registered for intent type: ${intentType}`);
    }
    this.operations.set(intentType, operation);
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

  async dispatch<I extends Intent>(
    intent: I,
    causation?: readonly string[]
  ): Promise<IntentResult<I>> {
    // Run interceptor pipeline
    let current: Intent | null = intent;
    for (const interceptor of this.interceptors) {
      current = await interceptor.before(current);
      if (current === null) {
        return undefined as IntentResult<I>;
      }
    }

    // Resolve operation
    const operation = this.operations.get(current.type);
    if (!operation) {
      throw new Error(`No operation registered for intent type: ${current.type}`);
    }

    // Build causation chain using intent type
    const causationChain = [...(causation ?? []), current.type];

    // Build dispatch function for nested dispatch
    const nestedDispatch: DispatchFn = <NI extends Intent>(
      nestedIntent: NI,
      nestedCausation?: readonly string[]
    ): Promise<IntentResult<NI>> => {
      const mergedCausation = [...causationChain, ...(nestedCausation ?? [])];
      return this.dispatch(nestedIntent, mergedCausation);
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
    return result as IntentResult<I>;
  }
}
