/**
 * Tests for the focus-trap utility.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFocusTrap } from "./focus-trap";

describe("createFocusTrap", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.tabIndex = -1;
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("focusFirst", () => {
    it("focuses the first focusable element when no autofocus attribute", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <button data-testid="second">Button</button>
      `;

      const trap = createFocusTrap(container);
      trap.focusFirst();

      const firstInput = container.querySelector('[data-testid="first"]');
      expect(document.activeElement).toBe(firstInput);
    });

    it("focuses element with data-autofocus attribute instead of first element", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <button data-testid="second" data-autofocus>Button</button>
        <input type="text" data-testid="third" />
      `;

      const trap = createFocusTrap(container);
      trap.focusFirst();

      const autofocusButton = container.querySelector('[data-testid="second"]');
      expect(document.activeElement).toBe(autofocusButton);
    });

    it("focuses first element when data-autofocus is on non-focusable element", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <div data-autofocus>Not focusable</div>
        <button data-testid="second">Button</button>
      `;

      const trap = createFocusTrap(container);
      trap.focusFirst();

      // The div with data-autofocus is not in focusables, so first input gets focus
      const firstInput = container.querySelector('[data-testid="first"]');
      expect(document.activeElement).toBe(firstInput);
    });

    it("focuses container when no focusable elements exist", () => {
      container.innerHTML = `<div>No focusable elements here</div>`;

      const trap = createFocusTrap(container);
      trap.focusFirst();

      expect(document.activeElement).toBe(container);
    });
  });

  describe("tab trapping", () => {
    it("wraps focus from last to first element on Tab", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <button data-testid="last">Button</button>
      `;

      const trap = createFocusTrap(container);
      trap.activate();

      const lastButton = container.querySelector('[data-testid="last"]') as HTMLElement;
      const firstInput = container.querySelector('[data-testid="first"]') as HTMLElement;

      lastButton.focus();
      expect(document.activeElement).toBe(lastButton);

      // Simulate Tab key on last element
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(firstInput);
    });

    it("wraps focus from first to last element on Shift+Tab", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <button data-testid="last">Button</button>
      `;

      const trap = createFocusTrap(container);
      trap.activate();

      const firstInput = container.querySelector('[data-testid="first"]') as HTMLElement;
      const lastButton = container.querySelector('[data-testid="last"]') as HTMLElement;

      firstInput.focus();
      expect(document.activeElement).toBe(firstInput);

      // Simulate Shift+Tab key on first element
      const shiftTabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(shiftTabEvent);

      expect(document.activeElement).toBe(lastButton);
    });

    it("deactivate stops trapping focus", () => {
      container.innerHTML = `
        <input type="text" data-testid="first" />
        <button data-testid="last">Button</button>
      `;

      const trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate();

      const lastButton = container.querySelector('[data-testid="last"]') as HTMLElement;
      lastButton.focus();

      // Simulate Tab key - should not wrap (event handler removed)
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(tabEvent);

      // Focus should still be on last button (no wrapping because deactivated)
      expect(document.activeElement).toBe(lastButton);
    });
  });
});
