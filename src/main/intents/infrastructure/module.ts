/**
 * IntentModule interface — declarative hook and event contributions.
 *
 * Modules declare their hook handlers and event subscriptions declaratively.
 * The wire utility reads these declarations and registers them with the
 * HookRegistry and Dispatcher.
 */

import type { DomainEvent } from "./types";
import type { HookHandler } from "./operation";
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
  /** Optional cleanup when the module is disposed. */
  dispose?(): void;
}
