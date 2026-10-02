/**
 * IntentModule interface — declarative hook and event contributions.
 *
 * Modules declare their hook handlers and event subscriptions declaratively.
 * The wire utility reads these declarations and registers them with the
 * Dispatcher.
 */

import type { DomainEvent } from "./types";
import type {
  FrameOf,
  HookHandler,
  HookHandlerReturn,
  HookPointOf,
  HookResultOf,
  InputOf,
  IntentOf,
  OperationSchemas,
} from "./operation";
import type { IntentInterceptor } from "./dispatcher";

// =============================================================================
// Declaration Types
// =============================================================================

/**
 * Hook declarations: operationId → hookPointId → HookHandler.
 * Each module contributes handlers to specific hook points on specific operations.
 */
export type HookDeclarations = Readonly<Record<string, Readonly<Record<string, HookHandler>>>>;

/**
 * A handler registered for a domain event type.
 * Mirrors HookHandler: supports `requires` for capability-based gating.
 */
export interface EventHandler {
  readonly handler: (event: DomainEvent) => Promise<void>;
  /** Capabilities this handler requires. Checked against initial capabilities at emit time. */
  readonly requires?: Readonly<Record<string, unknown>>;
}

/**
 * Event declarations: eventType → EventHandler.
 * Each module contributes handlers for domain events.
 */
export type EventDeclarations = Readonly<Record<string, EventHandler>>;

// =============================================================================
// Typed Declarations
// =============================================================================
//
// The declaration types above are what the dispatcher holds: erased, so one
// registry serves every operation. A module writes its handlers against the
// typed views below instead, and the helpers erase them. The handler then
// receives the context its hook point's `input` schema describes (the
// operation's own intent included), returns that hook point's `result`, and an
// event handler receives the event its type names — no casts, and a handler
// declared on the wrong operation, hook point or event fails to compile.

/**
 * The context a handler for hook point `K` receives: {@link InputOf} (the enrichment the
 * operation adds) with the intent narrowed to the operation's own. Every hook point's `input`
 * schema re-affirms the operation's payload (`hookCtxSchema`) and the dispatcher validates
 * each context against it before a handler sees it — which is what makes the erasure in
 * {@link eraseHooks} / {@link hookDeclarer} sound. Operations keep building the wider
 * {@link InputOf}.
 */
export type HandlerInputOf<S extends OperationSchemas, K extends HookPointOf<S>> = InputOf<S, K> & {
  readonly intent: IntentOf<S>;
};

/** A handler for hook point `K` of the operation whose schema bundle is `S`. */
export interface HookHandlerFor<S extends OperationSchemas, K extends HookPointOf<S>> {
  readonly handler: (
    ctx: HandlerInputOf<S, K>
  ) => HookHandlerReturn<HookResultOf<S, K>, FrameOf<S, K>>;
  /** Capabilities this handler requires before it can execute (see {@link HookHandler}). */
  readonly requires?: Readonly<Record<string, unknown>>;
}

/** One operation's hook contributions: hookPointId → typed handler. */
export type OperationHooks<S extends OperationSchemas> = {
  readonly [K in HookPointOf<S>]?: HookHandlerFor<S, K>;
};

/** Hook contributions across operations, keyed by operation id through `M` (id → schemas). */
export type TypedHookDeclarations<M> = {
  readonly [Id in keyof M & string]?: M[Id] extends OperationSchemas
    ? OperationHooks<M[Id]>
    : never;
};

/** A handler for one domain event type, receiving that event's own type. */
export interface TypedEventHandler<E extends DomainEvent> {
  readonly handler: (event: E) => Promise<void>;
  /** Capabilities this handler requires (see {@link EventHandler}). */
  readonly requires?: Readonly<Record<string, unknown>>;
}

/** Event subscriptions keyed by event type through `M` (event type → event). */
export type TypedEventDeclarations<M> = {
  readonly [T in keyof M & string]?: M[T] extends DomainEvent ? TypedEventHandler<M[T]> : never;
};

/**
 * Erase one operation's typed hook handlers into the dispatcher's declaration shape.
 *
 * `schemas` is read only for its type. For an operation outside the app's
 * `OperationSchemaMap` (a test operation); modules use `defineHooks` from
 * `src/intents/declarations.ts`, which also checks the operation id.
 */
export function hooksFor<S extends OperationSchemas>(
  _schemas: S,
  hooks: OperationHooks<S>
): Readonly<Record<string, HookHandler>> {
  return eraseHooks(hooks);
}

/**
 * The one place a typed handler is widened to the erased {@link HookHandler}: its parameter
 * is narrower than `HookContext`, which the function type cannot express. Sound because the
 * dispatcher checks each context against the hook point's `input` schema before the call.
 */
export function eraseHooks<S extends OperationSchemas>(
  hooks: OperationHooks<S>
): Readonly<Record<string, HookHandler>> {
  return hooks as Readonly<Record<string, HookHandler>>;
}

/**
 * A declarer of hook contributions across the operations `M` names (id → schemas): an
 * identity function at runtime, typed so each handler gets its hook point's context.
 */
export function hookDeclarer<M>(): (hooks: TypedHookDeclarations<M>) => HookDeclarations {
  // Same widening as eraseHooks, one level up (operation id → hook point → handler).
  return (hooks) => hooks as unknown as HookDeclarations;
}

/**
 * A declarer of event subscriptions across the events `M` names (type → event): an identity
 * function at runtime, typed so each handler gets its own event type. The widening is sound
 * because the dispatcher hands a handler only the events of the type it is registered for,
 * each validated against that type's payload schema at emit.
 */
export function eventDeclarer<M>(): (events: TypedEventDeclarations<M>) => EventDeclarations {
  return (events) => events as unknown as EventDeclarations;
}

// =============================================================================
// IntentModule Interface
// =============================================================================

/**
 * A module that contributes hooks and/or event subscriptions to the intent system.
 * Modules are registered at bootstrap via `dispatcher.registerModule()`.
 */
export interface IntentModule {
  /** Human-readable module name for logging and diagnostics. */
  readonly name: string;
  /** Capabilities every handler in this module requires. Merged into each hook and event handler's `requires` at registration (handler-level overrides on conflict). */
  readonly requires?: Readonly<Record<string, unknown>>;
  /** Hook contributions: operationId → hookPointId → HookHandler */
  readonly hooks?: HookDeclarations;
  /** Event subscriptions: eventType → handler */
  readonly events?: EventDeclarations;
  /** Interceptors to add to the dispatcher pipeline */
  readonly interceptors?: readonly IntentInterceptor[];
}
