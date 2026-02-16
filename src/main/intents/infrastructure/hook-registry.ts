/**
 * HookRegistry — stores and resolves module hook contributions.
 *
 * Hooks are organized by operation ID and hook point ID.
 * When resolved, `collect()` runs all handlers in registration order with
 * frozen context clones, collecting typed results and errors.
 */

import type { HookContext, HookHandler, HookResult, ResolvedHooks } from "./operation";

// =============================================================================
// IHookRegistry Interface
// =============================================================================

/**
 * Registry that stores hook handler contributions and resolves them
 * into executable ResolvedHooks for a given operation.
 */
export interface IHookRegistry {
  /**
   * Register a hook handler for a specific operation and hook point.
   * Handlers are stored in registration order.
   */
  register(operationId: string, hookPointId: string, handler: HookHandler): void;

  /**
   * Resolve all hook handlers for an operation into a ResolvedHooks object.
   * The returned object's `collect()` method executes handlers for a given hook point.
   */
  resolve(operationId: string): ResolvedHooks;
}

// =============================================================================
// HookRegistry Implementation
// =============================================================================

export class HookRegistry implements IHookRegistry {
  private readonly handlers = new Map<string, Map<string, HookHandler[]>>();

  register(operationId: string, hookPointId: string, handler: HookHandler): void {
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

  resolve(operationId: string): ResolvedHooks {
    const opMap = this.handlers.get(operationId);
    return {
      async collect<T = unknown>(
        hookPointId: string,
        inputCtx: HookContext
      ): Promise<HookResult<T>> {
        const handlers = opMap?.get(hookPointId);
        if (!handlers) {
          return { results: [], errors: [] };
        }

        const results: T[] = [];
        const errors: Error[] = [];

        for (const entry of handlers) {
          try {
            const frozenCtx = Object.freeze({ ...inputCtx });
            const result = await entry.handler(frozenCtx);
            if (result !== undefined && result !== null) {
              results.push(result as T);
            }
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }

        return { results, errors };
      },
    };
  }
}
