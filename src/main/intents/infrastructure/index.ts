/**
 * Intent infrastructure barrel export.
 *
 * Re-exports all public types and classes for the intent-operation architecture.
 */

// Types
export type { Intent, IntentResult, DomainEvent } from "./types";

// Operation types
export type {
  Operation,
  OperationContext,
  DispatchFn,
  HookContext,
  HookHandler,
  ResolvedHooks,
} from "./operation";

// HookRegistry
export type { IHookRegistry } from "./hook-registry";
export { HookRegistry } from "./hook-registry";

// Dispatcher
export type { IDispatcher, IntentInterceptor, EventHandler } from "./dispatcher";
export { Dispatcher, IntentHandle } from "./dispatcher";

// Module
export type { IntentModule, HookDeclarations, EventDeclarations } from "./module";

// Wire
export { wireModules } from "./wire";
