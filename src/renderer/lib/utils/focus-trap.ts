/**
 * Focus trap utility for dialogs.
 * Traps keyboard focus within a container element.
 */

/**
 * Selector for focusable elements (disabled controls excluded).
 * Includes standard HTML focusable elements and vscode-elements web components.
 */
const FOCUSABLE_SELECTOR = [
  // Standard focusable elements
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  // vscode-elements web components (they handle focus internally)
  "vscode-button:not([disabled])",
  "vscode-checkbox:not([disabled])",
  "vscode-textfield:not([disabled])",
  "vscode-textarea:not([disabled])",
  "vscode-single-select:not([disabled])",
].join(", ");

/**
 * Keep Tab/Shift+Tab cycling inside a container: wraps at the boundaries and
 * pulls focus back in when it sits outside the container (so tabbing can
 * never leave the form). Call from a keydown handler; non-Tab keys are
 * ignored.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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

export interface FocusTrap {
  /** Start trapping focus within the container */
  activate: () => void;
  /** Stop trapping focus */
  deactivate: () => void;
  /** Focus the first focusable element */
  focusFirst: () => void;
  /** Focus an element matching the selector, or first focusable if not found */
  focusSelector: (selector: string) => void;
}

/**
 * Creates a focus trap for a container element.
 * @param container - The element to trap focus within
 * @returns Focus trap controls
 */
export function createFocusTrap(container: HTMLElement): FocusTrap {
  function getFocusables(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function handleKeyDown(event: KeyboardEvent): void {
    trapTabKey(event, container);
  }

  return {
    activate: () => container.addEventListener("keydown", handleKeyDown),
    deactivate: () => container.removeEventListener("keydown", handleKeyDown),
    focusFirst: () => {
      const focusables = getFocusables();
      // Prefer element with data-autofocus attribute (avoids a11y_autofocus warning)
      const autofocused = focusables.find((el) => el.hasAttribute("data-autofocus"));
      const target = autofocused ?? focusables[0];
      if (target) {
        target.focus();
      } else {
        // Fall back to container if no focusable elements
        container.focus();
      }
    },
    focusSelector: (selector: string) => {
      const element = container.querySelector<HTMLElement>(selector);
      if (element) {
        element.focus();
      } else {
        // Fall back to first focusable if selector not found
        const first = getFocusables()[0];
        if (first) {
          first.focus();
        } else {
          container.focus();
        }
      }
    },
  };
}
