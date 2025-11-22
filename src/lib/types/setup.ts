/**
 * Setup types for runtime initialization progress events.
 * These mirror the Rust SetupEvent and SetupStep types.
 */

/** Steps in the runtime setup process. */
export type SetupStep = 'node' | 'codeServer' | 'extensions';

/** Events emitted during runtime setup. */
export type SetupEvent =
  | { type: 'stepStarted'; step: SetupStep }
  | { type: 'progress'; step: SetupStep; percent: number; message?: string }
  | { type: 'stepCompleted'; step: SetupStep }
  | { type: 'stepFailed'; step: SetupStep; error: string }
  | { type: 'setupComplete' };

/** State of a setup step. */
export type StepState = 'pending' | 'inProgress' | 'completed' | 'failed';

/** Human-readable labels for setup steps. */
export const STEP_LABELS: Record<SetupStep, string> = {
  node: 'Node.js runtime',
  codeServer: 'code-server',
  extensions: 'Extensions',
};

/** Captions shown during each step. */
export const STEP_CAPTIONS: Record<SetupStep, string> = {
  node: 'Downloading Node.js runtime...',
  codeServer: 'Downloading code-server...',
  extensions: 'Downloading extensions...',
};
