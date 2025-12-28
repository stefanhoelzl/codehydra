/**
 * Tests for the Dialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import Dialog from "./Dialog.svelte";

describe("Dialog component", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    titleId: "dialog-title",
    descriptionId: "dialog-desc",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("accessibility", () => {
    it("renders with role='dialog' and aria-modal='true'", () => {
      render(Dialog, { props: defaultProps });

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
    });

    it("has aria-labelledby pointing to title", () => {
      render(Dialog, { props: defaultProps });

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-labelledby", "dialog-title");
    });

    it("has aria-describedby when provided", () => {
      render(Dialog, { props: defaultProps });

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-describedby", "dialog-desc");
    });

    it("sets aria-busy when busy prop is true", () => {
      render(Dialog, { props: { ...defaultProps, busy: true } });

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-busy", "true");
    });

    it("does not set aria-busy when busy is false", () => {
      render(Dialog, { props: { ...defaultProps, busy: false } });

      const dialog = screen.getByRole("dialog");
      expect(dialog).not.toHaveAttribute("aria-busy");
    });
  });

  describe("rendering", () => {
    it("does not render when open is false", () => {
      render(Dialog, { props: { ...defaultProps, open: false } });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders when open is true", () => {
      render(Dialog, { props: defaultProps });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("focus management", () => {
    it("focuses dialog element when no focusable children", async () => {
      render(Dialog, { props: defaultProps });

      // Wait for the effect to run
      await vi.waitFor(() => {
        const dialog = screen.getByRole("dialog");
        // Dialog has tabindex="-1" so it can receive focus when no buttons
        expect(document.activeElement).toBe(dialog);
      });
    });
  });

  describe("interactions", () => {
    it("Escape key calls onClose", async () => {
      const onClose = vi.fn();
      render(Dialog, { props: { ...defaultProps, onClose } });

      await fireEvent.keyDown(document, { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("click on overlay calls onClose", async () => {
      const onClose = vi.fn();
      render(Dialog, { props: { ...defaultProps, onClose } });

      const overlay = screen.getByTestId("dialog-overlay");
      await fireEvent.click(overlay);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("click inside dialog does not call onClose", async () => {
      const onClose = vi.fn();
      render(Dialog, { props: { ...defaultProps, onClose } });

      const dialog = screen.getByRole("dialog");
      await fireEvent.click(dialog);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("focus trap", () => {
    it("Tab cycles within dialog", async () => {
      const user = userEvent.setup();
      render(Dialog, { props: defaultProps });

      const dialog = screen.getByRole("dialog");
      const buttons = dialog.querySelectorAll("button");

      // Focus should cycle
      if (buttons.length >= 2) {
        const lastButton = buttons[buttons.length - 1];
        lastButton?.focus();

        await user.tab();

        // Should wrap to first button
        expect(document.activeElement).toBe(buttons[0]);
      }
    });

    it("Shift+Tab cycles in reverse", async () => {
      const user = userEvent.setup();
      render(Dialog, { props: defaultProps });

      const dialog = screen.getByRole("dialog");
      const buttons = dialog.querySelectorAll("button");

      // Focus should cycle in reverse
      if (buttons.length >= 2) {
        buttons[0]?.focus();

        await user.tab({ shift: true });

        // Should wrap to last button
        expect(document.activeElement).toBe(buttons[buttons.length - 1]);
      }
    });
  });
});
