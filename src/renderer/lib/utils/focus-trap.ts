/**
 * Focus trap utility for dialogs.
 * Traps keyboard focus within a container element.
 */

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface FocusTrap {
  /** Start trapping focus within the container */
  activate: () => void;
  /** Stop trapping focus */
  deactivate: () => void;
  /** Focus the first focusable element */
  focusFirst: () => void;
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
    if (event.key !== "Tab") return;

    const focusables = getFocusables();
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
  };
}
