/**
 * Dispatcher — single entry point for the intent-operation pipeline.
 *
 * Orchestrates: interceptor pipeline → operation resolution → hook execution → emit events.
 * Stores hook handlers internally and runs them with capability-based ordering.
 *
 * Logs:
 * - Intent dispatch start (info)
 * - Interceptor blocks (debug)
 * - Hook point execution with timing, module names in execution order, results, errors (debug)
 * - Hook modules skipped due to unsatisfied capabilities (debug)
 * - Hook errors (debug)
 * - Intent completion with timing (info)
 * - Intent failure (error)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { z } from "zod/v4";
import type { Intent, IntentResult, DomainEvent } from "./types";
import type {
  Operation,
  OperationContext,
  OperationSchemas,
  IntentOf,
  HookPointSchemas,
  DispatchFn,
  ResolvedHooks,
  CollectOptions,
  HookContext,
  HookHandler,
  HookHandlerReturn,
  HookOutput,
  HookResult,
} from "./operation";
import { ANY_VALUE } from "./operation";
import type { IntentModule } from "./module";
import type { Logger } from "../../boundaries/platform/logging-types";

// =============================================================================
// Internal types (not exposed to operations)
// =============================================================================

interface SkippedHandler {
  readonly name: string;
  readonly unsatisfied: readonly string[];
}

interface CollectResult<T = unknown> extends HookResult<T> {
  readonly ran: readonly string[];
  readonly skipped: readonly SkippedHandler[];
}

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
  before(intent: Intent): Promise<Intent | null>;
}

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
  subscribe(eventType: string, handler: (event: DomainEvent) => void): () => void;
  addInterceptor(interceptor: IntentInterceptor): void;
  registerModule(module: IntentModule): void;
}

// =============================================================================
// Dispatcher Implementation
// =============================================================================

export class Dispatcher implements IDispatcher {
  private readonly operations = new Map<string, Operation>();
  private readonly interceptors: IntentInterceptor[] = [];
  private readonly causationContext = new AsyncLocalStorage<readonly string[]>();
  private readonly handlers = new Map<string, Map<string, HookHandler[]>>();
  /** operationId → schemas (payload/result/hooks), indexed at registerOperation. */
  private readonly operationSchemas = new Map<string, OperationSchemas>();
  /** eventType → payload schema, folded from every operation's `schemas.events`. */
  private readonly eventSchemas = new Map<string, z.ZodType>();
  private readonly initialCapabilities: Readonly<Record<string, unknown>>;
  private readonly logger: Logger;

  constructor(options: {
    logger: Logger;
    initialCapabilities?: Readonly<Record<string, unknown>>;
  }) {
    this.logger = options.logger;
    this.initialCapabilities = Object.freeze({ ...options.initialCapabilities });
  }

  /**
   * Register an operation for a specific intent type.
   * Only one operation per intent type is allowed.
   *
   * Generic to accept operations with specific intent types. Type safety
   * is maintained by dispatch() matching intent.type to the correct operation.
   */
  registerOperation<S extends OperationSchemas>(operation: Operation<S>): void {
    // The intent type is the operation's registration key — read from its schema bundle,
    // so registration needs no separate intent-type argument.
    const intentType = operation.schemas.type;
    if (this.operations.has(intentType)) {
      throw new Error(`Operation already registered for intent type: ${intentType}`);
    }
    this.operations.set(intentType, operation as unknown as Operation);
    this.operationSchemas.set(operation.id, operation.schemas);
    for (const [eventType, schema] of Object.entries(operation.schemas.events ?? {})) {
      if (this.eventSchemas.has(eventType)) {
        throw new Error(`Event schema already registered for event type: ${eventType}`);
      }
      this.eventSchemas.set(eventType, schema);
    }
    this.logger.debug("register operation", { intent: intentType });
  }

  addInterceptor(interceptor: IntentInterceptor): void {
    this.interceptors.push(interceptor);
  }

  registerModule(module: IntentModule): void {
    this.logger.debug("register module", { module: module.name });
    if (module.hooks) {
      for (const [operationId, hookPoints] of Object.entries(module.hooks)) {
        for (const [hookPointId, handler] of Object.entries(hookPoints)) {
          const mergedHandler: HookHandler = {
            name: module.name,
            ...handler,
            ...(module.requires && {
              requires: { ...module.requires, ...handler.requires },
            }),
          };
          this.registerHandler(operationId, hookPointId, mergedHandler);
          this.logger.silly("  hook", { module: module.name, op: operationId, hook: hookPointId });
        }
      }
    }
    if (module.events) {
      for (const [eventType, eventHandler] of Object.entries(module.events)) {
        const mergedRequires =
          module.requires || eventHandler.requires
            ? { ...module.requires, ...eventHandler.requires }
            : undefined;
        const hookHandler: HookHandler = {
          name: module.name,
          handler: async (ctx: HookContext): Promise<void> => {
            await eventHandler.handler(ctx.intent as unknown as DomainEvent);
          },
          ...(mergedRequires && { requires: mergedRequires }),
        };
        this.registerHandler(`event:${eventType}`, "handle", hookHandler);
        this.logger.silly("  event", { module: module.name, event: eventType });
      }
    }
    if (module.interceptors) {
      for (const interceptor of module.interceptors) {
        this.addInterceptor(interceptor);
        this.logger.silly("  interceptor", { module: module.name, interceptor: interceptor.id });
      }
    }
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => void): () => void {
    let active = true;
    this.registerHandler(`event:${eventType}`, "handle", {
      handler: async (ctx: HookContext): Promise<void> => {
        if (active) handler(ctx.intent as unknown as DomainEvent);
      },
    });
    return () => {
      active = false;
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

  // ===========================================================================
  // Hook storage
  // ===========================================================================

  private registerHandler(operationId: string, hookPointId: string, handler: HookHandler): void {
    let opMap = this.handlers.get(operationId);
    if (!opMap) {
      opMap = new Map<string, HookHandler[]>();
      this.handlers.set(operationId, opMap);
    }
    let hookList = opMap.get(hookPointId);
    if (!hookList) {
      hookList = [];
      opMap.set(hookPointId, hookList);
    }
    hookList.push(handler);
  }

  // ===========================================================================
  // Hook collection (capability-based topological sort)
  // ===========================================================================

  private async collectHookResults<T>(
    hookHandlers: HookHandler[],
    inputCtx: HookContext,
    initialCaps: Readonly<Record<string, unknown>>,
    onYield?: (frame: unknown) => void | Promise<void>,
    hookSchemas?: HookPointSchemas
  ): Promise<CollectResult<T>> {
    const capabilities: Record<string, unknown> = {
      ...initialCaps,
      ...((inputCtx.capabilities as Record<string, unknown> | undefined) ?? {}),
    };
    let pending = [...hookHandlers];
    const results: T[] = [];
    const errors: Error[] = [];
    const ran: string[] = [];

    while (pending.length > 0) {
      let progressMade = false;
      const nextPending: HookHandler[] = [];

      for (const entry of pending) {
        const reqs = entry.requires ?? {};
        if (requirementsSatisfied(reqs, capabilities)) {
          const frozenCtx: HookContext = Object.freeze({
            ...inputCtx,
            capabilities: Object.freeze({ ...capabilities }),
          });
          // Whole-context validation (item 2): the input schema re-affirms the intent,
          // shape-checks the scalar capability bag, and validates the enrichment. A failure
          // here means the operation built a bad context — a framework bug — so it throws
          // out of collect (not caught per-handler), aborting the operation → reject.
          if (hookSchemas?.input) hookSchemas.input.parse(frozenCtx);
          try {
            // A handler returns a HookOutput (result and/or provided capabilities);
            // void is shorthand for an empty output. A streaming handler is an
            // async generator: drain its yielded progress frames to onYield (host-side),
            // and use its return value as the output. The non-generator path stays a
            // plain await (no extra microtask hop) to preserve emit/dispatch timing.
            const invoked = entry.handler(frozenCtx);
            const output: HookOutput =
              (isAsyncGenerator(invoked)
                ? await drainGenerator(invoked, onYield)
                : await invoked) ?? {};
            if (output.result !== undefined && output.result !== null) {
              // Validate + normalize (strip) each handler's partial result. A failure is
              // isolated to this handler (pushed to errors[]), like a throwing handler.
              const validated = hookSchemas?.result
                ? hookSchemas.result.parse(output.result)
                : output.result;
              results.push(validated as T);
            }
            // Merge provided capabilities from returned data (no host-side closure).
            // Skip undefined-valued keys: requires/ANY_VALUE test key *presence*, so a
            // key must only appear when it carries a defined value.
            if (output.provides) {
              const validated = hookSchemas?.provides
                ? hookSchemas.provides.parse(output.provides)
                : output.provides;
              for (const [key, value] of Object.entries(validated)) {
                if (value !== undefined) capabilities[key] = value;
              }
            }
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
          if (entry.name) ran.push(entry.name);
          progressMade = true;
        } else {
          nextPending.push(entry);
        }
      }

      pending = nextPending;
      if (!progressMade) break;
    }

    const skipped: SkippedHandler[] = [];
    for (const entry of pending) {
      if (entry.name) {
        skipped.push({
          name: entry.name,
          unsatisfied: unsatisfiedKeys(entry.requires ?? {}, capabilities),
        });
      }
    }

    return {
      results,
      errors,
      capabilities: Object.freeze({ ...capabilities }),
      ran,
      skipped,
    };
  }

  // ===========================================================================
  // Hook resolution
  // ===========================================================================

  private resolveHooks(operationId: string): ResolvedHooks {
    const opMap = this.handlers.get(operationId);
    const opHooks = this.operationSchemas.get(operationId)?.hooks;
    const initCaps = this.initialCapabilities;
    const logger = this.logger;
    return {
      collect: async <T>(
        hookPointId: string,
        ctx: HookContext,
        options?: CollectOptions
      ): Promise<HookResult<T>> => {
        const hookHandlers = opMap?.get(hookPointId);
        if (!hookHandlers) {
          return { results: [], errors: [], capabilities: initCaps };
        }
        const start = performance.now();
        const { ran, skipped, ...hookResult } = await this.collectHookResults<T>(
          hookHandlers,
          ctx,
          initCaps,
          options?.onYield,
          opHooks?.[hookPointId]
        );
        const duration = Math.round(performance.now() - start);

        logger.debug("hook", {
          op: operationId,
          hook: hookPointId,
          modules: ran.join(","),
          results: hookResult.results.length,
          errors: hookResult.errors.length,
          ms: duration,
        });

        if (skipped.length > 0) {
          logger.debug("hook skipped", {
            op: operationId,
            hook: hookPointId,
            modules: skipped.map((s) => `${s.name}(${s.unsatisfied.join(",")})`).join(","),
          });
        }

        if (hookResult.errors.length > 0) {
          for (const error of hookResult.errors) {
            logger.warn("hook error", {
              op: operationId,
              hook: hookPointId,
              error: error.message,
            });
          }
        }

        return hookResult;
      },
    };
  }

  // ===========================================================================
  // Pipeline
  // ===========================================================================

  private async emitEvent(event: DomainEvent): Promise<void> {
    // Validate + normalize the event payload (fail → throw at emit).
    const schema = this.eventSchemas.get(event.type);
    const validated: DomainEvent = schema
      ? { ...event, payload: schema.parse(event.payload) }
      : event;
    const eventOpId = `event:${event.type}`;
    const resolved = this.resolveHooks(eventOpId);
    await resolved.collect("handle", { intent: validated as unknown as Intent });
  }

  private async runPipeline<I extends Intent>(
    intent: I,
    causation: readonly string[] | undefined,
    handle: IntentHandle<IntentResult<I>>
  ): Promise<void> {
    const pipelineStart = performance.now();

    try {
      this.logger.info("dispatch", {
        intent: intent.type,
        causation: causation?.join(" > ") ?? "",
      });

      // Run interceptor pipeline
      let current: Intent | null = intent;
      for (const interceptor of this.interceptors) {
        current = await interceptor.before(current);
        if (current === null) {
          this.logger.debug("interceptor blocked", {
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

      // Validate + normalize (strip) the intent payload; a failure rejects the dispatch
      // via the outer catch. The parsed value is forwarded so downstream sees normalized data.
      const opSchemas = this.operationSchemas.get(operation.id);
      if (opSchemas?.payload) {
        current = { ...current, payload: opSchemas.payload.parse(current.payload) };
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
      const hooks = this.resolveHooks(operation.id);

      // Build operation context
      const ctx: OperationContext<Intent> = {
        intent: current,
        dispatch: nestedDispatch,
        emit: (event: DomainEvent) => this.emitEvent(event),
        hooks,
        causation: causationChain,
      };

      // Execute operation within causation context so that any dispatcher.dispatch() calls
      // from hooks inherit the chain. The stored operation is erased to `Operation` (any
      // schema); its `execute` is typed to its own IntentOf, so the generic `ctx` is bridged
      // with a cast here (the intent's phantom result carrier never exists at runtime — the
      // payload was already validated above). Call `execute` as a METHOD so `this` stays bound.
      const opCtx = ctx as unknown as OperationContext<IntentOf<OperationSchemas>>;
      const result = await this.causationContext.run(causationChain, () =>
        operation.execute(opCtx)
      );

      // Validate + normalize the operation's return value (fail → reject via outer catch).
      const validatedResult = opSchemas?.result ? opSchemas.result.parse(result) : result;

      const duration = Math.round(performance.now() - pipelineStart);
      this.logger.info("completed", { intent: current.type, ms: duration });

      handle.resolve(validatedResult as IntentResult<I>);
    } catch (e) {
      this.logger.error("failed", {
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

// =============================================================================
// Hook handler draining
// =============================================================================

/** True when a handler's invocation returned an async generator (a streaming handler). */
function isAsyncGenerator(
  value: HookHandlerReturn
): value is AsyncGenerator<unknown, HookOutput | void, void> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * Drain a streaming (`async function*`) handler: forward each yielded frame to `onYield`
 * and return the generator's return value (its `HookOutput`).
 */
async function drainGenerator(
  gen: AsyncGenerator<unknown, HookOutput | void, void>,
  onYield?: (frame: unknown) => void | Promise<void>
): Promise<HookOutput | void> {
  let next = await gen.next();
  while (!next.done) {
    if (onYield) await onYield(next.value);
    next = await gen.next();
  }
  return next.value;
}

// =============================================================================
// Capability helpers
// =============================================================================

function requirementsSatisfied(
  requires: Readonly<Record<string, unknown>>,
  capabilities: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(requires)) {
    if (value === ANY_VALUE) {
      if (!(key in capabilities)) return false;
    } else {
      if (!(key in capabilities)) return false;
      if (capabilities[key] !== value) return false;
    }
  }
  return true;
}

function unsatisfiedKeys(
  requires: Readonly<Record<string, unknown>>,
  capabilities: Record<string, unknown>
): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(requires)) {
    if (value === ANY_VALUE) {
      if (!(key in capabilities)) keys.push(key);
    } else {
      if (!(key in capabilities) || capabilities[key] !== value) keys.push(key);
    }
  }
  return keys;
}
