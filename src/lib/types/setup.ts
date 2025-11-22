/**
 * Setup types for runtime initialization events.
 * These mirror the Rust SetupEvent types.
 * All UI state comes from the backend - frontend just renders what it receives.
 */

/** Events emitted during runtime setup. */
export type SetupEvent =
  | { type: 'update'; message: string; steps: StepStatus[] }
  | { type: 'complete' }
  | { type: 'failed'; error: string };

/** Status of a single setup step for UI display. */
export interface StepStatus {
  label: string;
  state: StepState;
}

/** Visual state of a setup step. */
export type StepState = 'pending' | 'inProgress' | 'completed' | 'failed';
