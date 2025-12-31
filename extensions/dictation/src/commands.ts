/**
 * Centralized command and context key identifiers
 */
export const COMMANDS = {
  TOGGLE: "codehydra.dictation.toggle",
  START: "codehydra.dictation.start",
  STOP: "codehydra.dictation.stop",
} as const;

export const CONTEXT_KEYS = {
  IS_RECORDING: "codehydra.dictation.isRecording",
} as const;
