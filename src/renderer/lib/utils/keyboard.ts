/**
 * Keyboard helpers shared across form components.
 */

/**
 * True for a plain Enter press (no Cmd/Ctrl). Form fields treat plain Enter as
 * "submit this field", while Cmd/Ctrl+Enter is the form-global gesture handled
 * by Form — so callers let modified Enter fall through.
 */
export function isPlainEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.ctrlKey && !e.metaKey;
}
