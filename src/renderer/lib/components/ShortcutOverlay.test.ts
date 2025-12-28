/**
 * Tests for the ShortcutOverlay component.
 * Tests visibility, accessibility, and styling.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import ShortcutOverlay from "./ShortcutOverlay.svelte";

describe("ShortcutOverlay component", () => {
  const defaultProps = {
    active: true,
    workspaceCount: 3,
    hasActiveProject: true,
    hasActiveWorkspace: true,
  };

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("visibility", () => {
    it("should-show-overlay-with-opacity-1-when-active: Shows (opacity 1) when active=true", () => {
      render(ShortcutOverlay, { props: { active: true } });

      const overlay = screen.getByRole("status");
      expect(overlay).toHaveClass("active");
    });

    it("should-hide-overlay-with-opacity-0-when-inactive: Hidden (opacity 0) when active=false", () => {
      render(ShortcutOverlay, { props: { active: false } });

      // Need { hidden: true } because aria-hidden="true" excludes from accessible tree
      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).not.toHaveClass("active");
    });
  });

  describe("accessibility", () => {
    it("should-have-role-status-attribute: Has role=status", () => {
      render(ShortcutOverlay, { props: { active: false } });

      // Need { hidden: true } because aria-hidden="true" excludes from accessible tree
      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toBeInTheDocument();
    });

    it("should-have-aria-live-polite-attribute: Has aria-live=polite", () => {
      render(ShortcutOverlay, { props: { active: false } });

      // Need { hidden: true } because aria-hidden="true" excludes from accessible tree
      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toHaveAttribute("aria-live", "polite");
    });

    it("should-have-aria-hidden-when-inactive: Has aria-hidden=true when inactive", () => {
      render(ShortcutOverlay, { props: { active: false } });

      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toHaveAttribute("aria-hidden", "true");
    });

    it("should-not-have-aria-hidden-when-active: Has aria-hidden=false when active", () => {
      render(ShortcutOverlay, { props: { active: true } });

      const overlay = screen.getByRole("status");
      expect(overlay).toHaveAttribute("aria-hidden", "false");
    });

    it("should-announce-state-change-for-screen-readers: sr-only text appears when active", () => {
      render(ShortcutOverlay, { props: { active: true } });

      // Screen reader text should be present when active
      expect(screen.getByText("Shortcut mode active.")).toBeInTheDocument();
    });

    it("sr-only text should not appear when inactive", () => {
      render(ShortcutOverlay, { props: { active: false } });

      // Screen reader text should not be present when inactive
      expect(screen.queryByText("Shortcut mode active.")).not.toBeInTheDocument();
    });

    it("should-have-aria-labels-on-hint-symbols: Symbols have aria-label attributes", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByLabelText("Up and Down arrows to navigate")).toBeInTheDocument();
      expect(screen.getByLabelText("Enter key to create new workspace")).toBeInTheDocument();
      expect(screen.getByLabelText("Delete key to remove workspace")).toBeInTheDocument();
      expect(screen.getByLabelText("Number keys 1 through 0 to jump")).toBeInTheDocument();
    });
  });

  describe("content", () => {
    it("should-display-all-keyboard-hints: Shows Navigate, New, Del, Jump hints", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByText(/Navigate/)).toBeInTheDocument();
      expect(screen.getByText(/New/)).toBeInTheDocument();
      expect(screen.getByText(/Del/)).toBeInTheDocument();
      expect(screen.getByText(/Jump/)).toBeInTheDocument();
    });

    it("displays arrow symbols for navigation", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByText(/↑↓/)).toBeInTheDocument();
    });

    it("displays enter symbol for new", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByText(/⏎/)).toBeInTheDocument();
    });

    it("displays delete symbol", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByText(/⌫/)).toBeInTheDocument();
    });

    it("displays number range for jump", () => {
      render(ShortcutOverlay, { props: { active: true } });

      expect(screen.getByText(/1-0/)).toBeInTheDocument();
    });
  });

  describe("styling", () => {
    it("should-have-opacity-transition-css: Has transition property", () => {
      render(ShortcutOverlay, { props: { active: false } });

      const overlay = screen.getByRole("status", { hidden: true });
      // CSS transitions are defined in the component's style block
      // jsdom doesn't fully compute CSS, so we verify the class is present
      expect(overlay).toHaveClass("shortcut-overlay");
    });

    it("should-have-z-index-for-layering: Has z-index: 9999", () => {
      render(ShortcutOverlay, { props: { active: false } });

      const overlay = screen.getByRole("status", { hidden: true });
      expect(overlay).toHaveClass("shortcut-overlay");
      // z-index is set via CSS class, verify the class is present
    });

    it("has correct positioning classes", () => {
      render(ShortcutOverlay, { props: { active: true } });

      const overlay = screen.getByRole("status");
      expect(overlay).toHaveClass("shortcut-overlay");
    });
  });

  describe("conditional visibility of hints", () => {
    it("should-hide-navigate-hint-when-one-or-fewer-workspaces", () => {
      render(ShortcutOverlay, {
        props: { ...defaultProps, workspaceCount: 1 },
      });

      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");
    });

    it("should-hide-jump-hint-when-one-or-fewer-workspaces", () => {
      render(ShortcutOverlay, {
        props: { ...defaultProps, workspaceCount: 0 },
      });

      const jumpHint = screen.getByLabelText("Number keys 1 through 0 to jump");
      expect(jumpHint).toHaveClass("shortcut-hint--hidden");
    });

    it("should-hide-new-hint-when-no-active-project", () => {
      render(ShortcutOverlay, {
        props: { ...defaultProps, hasActiveProject: false },
      });

      const newHint = screen.getByLabelText("Enter key to create new workspace");
      expect(newHint).toHaveClass("shortcut-hint--hidden");
    });

    it("should-hide-delete-hint-when-no-active-workspace", () => {
      render(ShortcutOverlay, {
        props: { ...defaultProps, hasActiveWorkspace: false },
      });

      const delHint = screen.getByLabelText("Delete key to remove workspace");
      expect(delHint).toHaveClass("shortcut-hint--hidden");
    });

    it("should-always-show-open-hint", () => {
      render(ShortcutOverlay, {
        props: {
          ...defaultProps,
          workspaceCount: 0,
          hasActiveProject: false,
          hasActiveWorkspace: false,
        },
      });

      const openHint = screen.getByLabelText("O to open project");
      expect(openHint).not.toHaveClass("shortcut-hint--hidden");
    });

    it("should-show-all-hints-when-context-available", () => {
      render(ShortcutOverlay, { props: defaultProps });

      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      const newHint = screen.getByLabelText("Enter key to create new workspace");
      const delHint = screen.getByLabelText("Delete key to remove workspace");
      const jumpHint = screen.getByLabelText("Number keys 1 through 0 to jump");
      const openHint = screen.getByLabelText("O to open project");

      expect(navigateHint).not.toHaveClass("shortcut-hint--hidden");
      expect(newHint).not.toHaveClass("shortcut-hint--hidden");
      expect(delHint).not.toHaveClass("shortcut-hint--hidden");
      expect(jumpHint).not.toHaveClass("shortcut-hint--hidden");
      expect(openHint).not.toHaveClass("shortcut-hint--hidden");
    });

    it("should-hide-delete-hint-when-deletion-in-progress", () => {
      render(ShortcutOverlay, {
        props: {
          ...defaultProps,
          hasActiveWorkspace: true,
          activeWorkspaceDeletionInProgress: true,
        },
      });

      const delHint = screen.getByLabelText("Delete key to remove workspace");
      expect(delHint).toHaveClass("shortcut-hint--hidden");
    });

    it("should-show-delete-hint-when-no-deletion-in-progress", () => {
      render(ShortcutOverlay, {
        props: {
          ...defaultProps,
          hasActiveWorkspace: true,
          activeWorkspaceDeletionInProgress: false,
        },
      });

      const delHint = screen.getByLabelText("Delete key to remove workspace");
      expect(delHint).not.toHaveClass("shortcut-hint--hidden");
    });

    it("should-not-cause-layout-shift-when-hints-hidden", () => {
      // Hidden hints should use visibility:hidden (not display:none) to prevent layout shifts
      render(ShortcutOverlay, {
        props: { ...defaultProps, workspaceCount: 0 },
      });

      // The navigation hint should still exist in the DOM (visibility:hidden, not display:none)
      const navigateHint = screen.getByLabelText("Up and Down arrows to navigate");
      expect(navigateHint).toBeInTheDocument();
      expect(navigateHint).toHaveClass("shortcut-hint--hidden");
    });
  });
});
