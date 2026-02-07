/**
 * Core intent infrastructure types.
 *
 * Intents describe what the system wants to do. They carry a type discriminator,
 * an immutable payload, and a phantom result type R for type-safe dispatch.
 */

/**
 * Base intent type. Concrete intents extend this with specific type literal,
 * payload shape, and result type R.
 *
 * The R type parameter is phantom (not used structurally) — it carries the
 * expected result type for type-safe dispatch via {@link IntentResult}.
 *
 * @example
 * interface SetMetadataIntent extends Intent<void> {
 *   readonly type: "workspace:set-metadata";
 *   readonly payload: SetMetadataPayload;
 * }
 */
export interface Intent<R = void> {
  readonly type: string;
  readonly payload: unknown;
  /** Phantom type carrier for {@link IntentResult} — never set at runtime. */
  readonly _brand?: R;
}

/**
 * Extract the result type from an intent type.
 * Uses conditional type inference to pull R from Intent<R>.
 */
export type IntentResult<I> = I extends Intent<infer R> ? R : never;

/**
 * Base domain event type. Fired after operations complete.
 * Concrete events extend this with specific type literal and payload shape.
 *
 * @example
 * interface MetadataChangedEvent extends DomainEvent {
 *   readonly type: "workspace:metadata-changed";
 *   readonly payload: MetadataChangedPayload;
 * }
 */
export interface DomainEvent {
  readonly type: string;
  readonly payload: unknown;
}
