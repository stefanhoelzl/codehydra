/**
 * Centralized command and context key identifiers
 */
export const COMMANDS = {
  TOGGLE: "codehydra.dictation.toggle",
  START: "codehydra.dictation.start",
  STOP: "codehydra.dictation.stop",
  CANCEL: "codehydra.dictation.cancel",
} as const;

/**
 * Context keys for conditional keybindings
 */
export const CONTEXT_KEYS = {
  IS_RECORDING: "codehydra.dictation.isRecording",
} as const;
