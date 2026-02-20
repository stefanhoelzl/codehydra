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
 * Event declarations: eventType → handler function.
 * Each module subscribes to domain events by type.
 */
export type EventDeclarations = Readonly<Record<string, (event: DomainEvent) => void>>;

// =============================================================================
// IntentModule Interface
// =============================================================================

/**
 * A module that contributes hooks and/or event subscriptions to the intent system.
 * Modules are registered at bootstrap via `dispatcher.registerModule()`.
 */
export interface IntentModule {
  /** Hook contributions: operationId → hookPointId → HookHandler */
  readonly hooks?: HookDeclarations;
  /** Event subscriptions: eventType → handler */
  readonly events?: EventDeclarations;
  /** Interceptors to add to the dispatcher pipeline */
  readonly interceptors?: readonly IntentInterceptor[];
  /** Optional cleanup when the module is disposed. */
  dispose?(): void;
}
