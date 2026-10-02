/**
 * Dispatcher — single entry point for the intent-operation pipeline.
 *
 * Orchestrates: interceptor pipeline → operation resolution → hook execution → emit events.
 * Stores hook handlers internally and runs them with capability-based ordering.
 *
 * Logs:
 * - Intent dispatch start (info), with the parent dispatch's trace and the causation chain
 *
 * Every line written while a dispatch runs — by any logger — carries that
 * dispatch's log scope (see `LogScope`): its trace id, intent, target workspace,
 * origin, and the module/hook whose handler is running. The dispatcher is the
 * only writer of that scope.
 * - Interceptor blocks (debug)
 * - Hook point execution with timing, module names in execution order, results, errors (debug)
 * - Hook modules skipped due to unsatisfied capabilities (debug)
 * - Hook errors (debug)
 * - Intent completion with timing (info)
 * - Intent failure (error)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
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
  LogTarget,
} from "./operation";
import { ANY_VALUE } from "./operation";
import type { IntentModule } from "./module";
import type { Logger, LogScope, LogScopeStore } from "../../boundaries/platform/logging-types";

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
// Dispatch origin + log scope
// =============================================================================

/** Where work entered the app — the entry point that started a dispatch. */
export type DispatchOrigin =
  | "startup"
  | "app"
  | "system"
  | "ui"
  | "shortcut"
  | "notification"
  | "cli"
  | "mcp"
  | "sidekick"
  | "auto-workspace"
  | "agent-hook";

/**
 * Who a dispatch is on behalf of, for its log scope. Given by the entry point
 * that starts it; inherited by every dispatch nested in it.
 */
export interface DispatchOptions {
  readonly origin?: DispatchOrigin;
  /** The calling workspace of an API call, as `<project>/<name>`. */
  readonly caller?: string;
  /** The API operation (or channel) the call invoked. */
  readonly api?: string;
}

/** A store that keeps no scope: for a dispatcher built without logging. */
const NO_LOG_SCOPE: LogScopeStore = {
  run: (_read, fn) => fn(),
  current: () => undefined,
  nameWorkspace: () => {},
  workspaceAt: () => undefined,
};

/**
 * One dispatch's identity for logging: created when it is dispatched, mutated
 * once its target is known, read by every line written while it runs.
 */
class DispatchFrame {
  readonly trace = randomBytes(3).toString("hex");
  intent: string;
  readonly origin: DispatchOrigin | undefined;
  readonly caller: string | undefined;
  readonly api: string | undefined;
  private project: string | undefined;
  private ws: string | undefined;
  private path: string | undefined;
  /** Set once this dispatch named its own target; until then it shows its parent's. */
  private ownProject = false;
  private ownWs = false;

  constructor(
    intent: string,
    readonly parent: DispatchFrame | undefined,
    options: DispatchOptions
  ) {
    this.intent = intent;
    this.origin = options.origin ?? parent?.origin;
    this.caller = options.caller ?? parent?.caller;
    this.api = options.api ?? parent?.api;
    this.project = parent?.project;
    this.ws = parent?.ws;
    this.path = parent?.path;
  }

  /** The intent-type chain from the root dispatch down to (and including) this one. */
  get chain(): readonly string[] {
    return [...(this.parent?.chain ?? []), this.intent];
  }

  /**
   * Record the target. The first one this dispatch names wins — an inherited
   * target is replaced, a project-only one may still gain its workspace, but a
   * workspace once named stays (switch A→B shows B in the switch it dispatches).
   */
  setTarget(target: LogTarget): void {
    // The workspace's path may become known after its name (a creation learns
    // it from the worktree it makes): it completes the target, never changes it.
    if (
      this.ownWs &&
      target.ws === this.ws &&
      target.project === this.project &&
      this.path === undefined
    ) {
      this.path = target.path;
      return;
    }
    if (this.ownWs) return;
    if (this.ownProject && target.project !== this.project) return;
    this.project = target.project;
    this.ws = target.ws;
    this.path = target.path;
    this.ownProject = true;
    this.ownWs = target.ws !== undefined;
  }

  scope(): LogScope {
    return {
      trace: this.trace,
      intent: this.intent,
      ...(this.project !== undefined && { project: this.project }),
      ...(this.ws !== undefined && { ws: this.ws }),
      ...(this.path !== undefined && { path: this.path }),
      ...(this.origin !== undefined && { origin: this.origin }),
      ...(this.caller !== undefined && { caller: this.caller }),
      ...(this.api !== undefined && { api: this.api }),
    };
  }
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
  dispatch<I extends Intent>(intent: I, options?: DispatchOptions): IntentHandle<IntentResult<I>>;
  /**
   * Run `fn` so every dispatch it starts carries `options` (a dispatch's own
   * options still win). For an entry point whose dispatches are spread over
   * code it does not own — the plugin adapter invoking registry entries.
   * An entry point starts roots: `fn` leaves whatever dispatch it runs in, so a
   * timer armed during app:start does not file an hour of polls under it.
   * Lines `fn` logs before dispatching get no scope.
   */
  withOrigin<T>(options: DispatchOptions, fn: () => T): T;
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
  /** The dispatch the current code runs on behalf of. */
  private readonly frames = new AsyncLocalStorage<DispatchFrame>();
  /** Options set by `withOrigin` for the dispatches started inside it. */
  private readonly origins = new AsyncLocalStorage<DispatchOptions>();
  private readonly handlers = new Map<string, Map<string, HookHandler[]>>();
  /** operationId → schemas (payload/result/hooks), indexed at registerOperation. */
  private readonly operationSchemas = new Map<string, OperationSchemas>();
  /** eventType → payload schema, folded from every operation's `schemas.events`. */
  private readonly eventSchemas = new Map<string, z.ZodType>();
  private readonly initialCapabilities: Readonly<Record<string, unknown>>;
  private readonly logger: Logger;
  private readonly logScope: LogScopeStore;
  private readonly concurrentHooks: () => boolean;

  constructor(options: {
    logger: Logger;
    initialCapabilities?: Readonly<Record<string, unknown>>;
    /** The logging service's scope store; without it, lines carry no dispatch scope. */
    logScope?: LogScopeStore;
    /**
     * Whether a hook point's ready handlers run concurrently rather than one at
     * a time. Read once per hook point, so a change applies from the next one.
     * Defaults to sequential.
     */
    concurrentHooks?: () => boolean;
  }) {
    this.logger = options.logger;
    this.logScope = options.logScope ?? NO_LOG_SCOPE;
    this.concurrentHooks = options.concurrentHooks ?? ((): boolean => false);
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

  dispatch<I extends Intent>(intent: I, options?: DispatchOptions): IntentHandle<IntentResult<I>> {
    return this.start(intent, this.frames.getStore(), options);
  }

  withOrigin<T>(options: DispatchOptions, fn: () => T): T {
    return this.frames.exit(() =>
      this.logScope.run(
        () => ({}),
        () => this.origins.run(options, fn)
      )
    );
  }

  /**
   * Start a dispatch nested in `parent` (undefined for a root). Its frame is
   * entered synchronously, so everything the pipeline starts inherits it.
   */
  private start<I extends Intent>(
    intent: I,
    parent: DispatchFrame | undefined,
    options: DispatchOptions | undefined
  ): IntentHandle<IntentResult<I>> {
    const handle = new IntentHandle<IntentResult<I>>();
    const frame = new DispatchFrame(intent.type, parent, {
      ...this.origins.getStore(),
      ...options,
    });
    this.frames.run(frame, () =>
      this.logScope.run(
        () => frame.scope(),
        () => void this.runPipeline(intent, frame, handle)
      )
    );
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

  /**
   * Run a hook point's handlers. Each runs once its `requires` are satisfied;
   * one whose requirements never are is skipped.
   *
   * Sequential (the default): handlers run one at a time, in registration
   * order within each pass. Concurrent (`concurrentHooks`): every handler
   * whose requirements are met starts at once, and each completion re-checks
   * the ones still waiting. Either way every handler runs to completion,
   * `results[]` carries no order a caller may rely on, and nothing guarantees
   * one handler starts before another unless a capability says so.
   */
  private async collectHookResults(
    hookHandlers: HookHandler[],
    inputCtx: HookContext,
    initialCaps: Readonly<Record<string, unknown>>,
    hookLabel: string,
    onYield?: (frame: unknown) => void | Promise<void>,
    hookSchemas?: HookPointSchemas
  ): Promise<CollectResult> {
    const frame = this.frames.getStore();
    const capabilities: Record<string, unknown> = {
      ...initialCaps,
      ...((inputCtx.capabilities as Record<string, unknown> | undefined) ?? {}),
    };
    let pending = [...hookHandlers];
    const results: unknown[] = [];
    const errors: Error[] = [];
    const ran: string[] = [];

    /**
     * The context a handler starts with: the capabilities provided so far.
     * Whole-context validation (item 2): the input schema re-affirms the intent,
     * shape-checks the scalar capability bag, and validates the enrichment. A
     * failure here means the operation built a bad context — a framework bug —
     * so it throws out of collect (not caught per-handler), aborting the
     * operation → reject.
     */
    const contextFor = (): HookContext => {
      const frozenCtx: HookContext = Object.freeze({
        ...inputCtx,
        capabilities: Object.freeze({ ...capabilities }),
      });
      if (hookSchemas?.input) hookSchemas.input.parse(frozenCtx);
      return frozenCtx;
    };

    /**
     * Start a handler. A handler returns a HookOutput (result and/or provided
     * capabilities); void is shorthand for an empty output. A streaming handler
     * is an async generator: drain its yielded progress frames to onYield
     * (host-side), and use its return value as the output. The non-generator
     * path returns the handler's own promise, so awaiting it adds no microtask
     * hop — that preserves emit/dispatch timing. The handler runs in a scope
     * naming its module and hook, so every line it causes says which handler
     * that was.
     */
    const invoke = (entry: HookHandler, ctx: HookContext): Promise<HookOutput | void> => {
      const run = (): Promise<HookOutput | void> => {
        const invoked = entry.handler(ctx);
        return isAsyncGenerator(invoked) ? drainGenerator(invoked, onYield) : invoked;
      };
      const name = entry.name;
      return name === undefined
        ? run()
        : this.logScope.run(() => ({ ...frame?.scope(), module: name, hook: hookLabel }), run);
    };

    /** Fold a finished handler's output into the results and the capability bag. */
    const absorb = (output: HookOutput): void => {
      if (output.result !== undefined && output.result !== null) {
        // Validate + normalize (strip) each handler's partial result. A failure is
        // isolated to this handler (pushed to errors[]), like a throwing handler.
        const validated = hookSchemas?.result
          ? hookSchemas.result.parse(output.result)
          : output.result;
        results.push(validated);
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
    };

    const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
    const ready = (entry: HookHandler): boolean =>
      requirementsSatisfied(entry.requires ?? {}, capabilities);

    // A lone handler has nothing to overlap with: it takes the sequential path,
    // whose timing (no extra microtask hops) is the same in both modes.
    if (hookHandlers.length > 1 && this.concurrentHooks()) {
      // Eager: start everything ready, wait for any one to finish, repeat.
      // A handler's synchronous part runs as it starts; `settle` never rejects.
      const settle = async (entry: HookHandler, ctx: HookContext): Promise<void> => {
        try {
          absorb((await invoke(entry, ctx)) ?? {});
        } catch (err) {
          errors.push(toError(err));
        }
        if (entry.name) ran.push(entry.name);
      };
      const inFlight = new Set<Promise<void>>();
      for (;;) {
        const starting = pending.filter(ready);
        pending = pending.filter((entry) => !starting.includes(entry));
        for (const entry of starting) {
          const running: Promise<void> = settle(entry, contextFor()).finally(() =>
            inFlight.delete(running)
          );
          inFlight.add(running);
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
      }
    } else {
      while (pending.length > 0) {
        let progressMade = false;
        const nextPending: HookHandler[] = [];

        for (const entry of pending) {
          if (ready(entry)) {
            const ctx = contextFor();
            try {
              absorb((await invoke(entry, ctx)) ?? {});
            } catch (err) {
              errors.push(toError(err));
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
    // Erased: the dispatcher stores handlers without their operation's schema bundle, so it
    // collects as `unknown` and the typed `ResolvedHooks<S>` view is applied at the operation
    // boundary (where the bundle is known). The runtime behaviour is identical either way.
    return {
      collect: async (
        hookPointId: string,
        ctx: HookContext,
        options?: CollectOptions
      ): Promise<HookResult> => {
        const hookHandlers = opMap?.get(hookPointId);
        if (!hookHandlers) {
          return { results: [], errors: [], capabilities: initCaps };
        }
        const start = performance.now();
        const { ran, skipped, ...hookResult } = await this.collectHookResults(
          hookHandlers,
          ctx,
          initCaps,
          operationId.startsWith("event:") ? operationId : hookPointId,
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
    frame: DispatchFrame,
    handle: IntentHandle<IntentResult<I>>
  ): Promise<void> {
    const pipelineStart = performance.now();
    const parent = frame.parent;

    try {
      // Caller and api are logged where they enter the tree, not on every line:
      // the parent links lead any nested dispatch back here.
      const introducesCaller = frame.caller !== parent?.caller || frame.api !== parent?.api;
      this.logger.info("dispatch", {
        intent: intent.type,
        ...(parent && { parent: parent.trace }),
        causation: parent?.chain.join(" > ") ?? "",
        ...(introducesCaller && frame.caller !== undefined && { caller: frame.caller }),
        ...(introducesCaller && frame.api !== undefined && { api: frame.api }),
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
      frame.intent = current.type;

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

      // Nested dispatch names this frame as its parent explicitly, so it nests
      // correctly even when called from a callback that lost the async context.
      const nestedDispatch: DispatchFn = async <NI extends Intent>(
        nestedIntent: NI
      ): Promise<IntentResult<NI>> => await this.start(nestedIntent, frame, undefined);

      // Resolve hooks for this operation
      const hooks = this.resolveHooks(operation.id);

      // Build operation context
      const ctx: OperationContext<Intent> = {
        intent: current,
        dispatch: nestedDispatch,
        emit: (event: DomainEvent) => this.emitEvent(event),
        hooks,
        causation: frame.chain,
        setLogTarget: (target: LogTarget) => {
          frame.setTarget(target);
          parent?.setTarget(target);
          // Every line scoped to this path, in any dispatch or none, can now name it.
          if (target.path !== undefined && target.ws !== undefined) {
            this.logScope.nameWorkspace(target.path, { project: target.project, ws: target.ws });
          }
        },
      };

      // The operation runs inside this dispatch's frame (entered in `start`), so any
      // dispatcher.dispatch() call from its hooks nests under it. The stored operation is
      // erased to `Operation` (any schema); its `execute` is typed to its own IntentOf, so
      // the generic `ctx` is bridged with a cast here (the intent's phantom result carrier
      // never exists at runtime — the payload was already validated above). Call `execute`
      // as a METHOD so `this` stays bound.
      const opCtx = ctx as unknown as OperationContext<IntentOf<OperationSchemas>>;
      const result = await operation.execute(opCtx);

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
