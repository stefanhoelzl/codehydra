/**
 * Focus trap utility for dialogs.
 * Traps keyboard focus within a container element.
 */

/**
 * Selector for focusable (tabbable) elements. Excludes disabled controls and
 * anything removed from the tab order (`tabindex="-1"`), so e.g. the
 * non-selected cards of a roving radio group are never treated as focus
 * targets. Includes standard HTML focusables and vscode-elements web
 * components (which handle focus internally). Private — callers use
 * getFocusables(), the single source of truth shared across the app.
 */
const FOCUSABLE_SELECTOR = [
  // Standard focusable elements
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
  // vscode-elements web components
  'vscode-button:not([disabled]):not([tabindex="-1"])',
  'vscode-checkbox:not([disabled]):not([tabindex="-1"])',
  'vscode-textfield:not([disabled]):not([tabindex="-1"])',
  'vscode-textarea:not([disabled]):not([tabindex="-1"])',
  'vscode-single-select:not([disabled]):not([tabindex="-1"])',
  'vscode-dropdown:not([disabled]):not([tabindex="-1"])',
].join(", ");

/**
 * All focusable (tabbable) elements within `container`, in DOM order. The
 * shared way to enumerate focus targets — keeps the selector itself private.
 */
export function getFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Keep Tab/Shift+Tab cycling inside a container: wraps at the boundaries and
 * pulls focus back in when it sits outside the container (so tabbing can
 * never leave the form). Call from a keydown handler; non-Tab keys are
 * ignored.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusables = getFocusables(container);
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  const inContainer = active instanceof Node && container.contains(active);
  if (event.shiftKey) {
    if (!inContainer || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (!inContainer || active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
