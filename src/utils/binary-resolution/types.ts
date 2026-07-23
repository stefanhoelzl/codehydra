/**
 * Types for binary resolution operations.
 */

/**
 * Binary types that can be resolved.
 *
 * Type-only re-export of the intent contract's `binaryTypeSchema` (zod is the single source
 * of truth, and stays confined to the intent system — the erased re-export keeps it out of
 * this module's imports).
 */
export type { BinaryType } from "../../intents/contract";
