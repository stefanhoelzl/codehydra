/**
 * Shared API type re-exports.
 *
 * (The former `ApiEvents` map typed the renderer's `api.on()` domain-event
 * channel, which was removed when the main↔renderer surface collapsed to the
 * two ui:state / ui:event channels — all renderer-bound state ships in the
 * ui:state snapshot now.)
 */

// Re-export for consumers that import from this module
export type { Unsubscribe } from "../types";
