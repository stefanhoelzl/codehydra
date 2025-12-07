/**
 * Tests for the EmptyState component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import EmptyState from "./EmptyState.svelte";

describe("EmptyState component", () => {
  const defaultProps = {
    onOpenProject: vi.fn(),
    shortcutModeActive: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No projects open" message', () => {
    render(EmptyState, { props: defaultProps });

    expect(screen.getByText("No projects open.")).toBeInTheDocument();
  });

  it('renders "Open Project" button', () => {
    render(EmptyState, { props: defaultProps });

    expect(screen.getByRole("button", { name: /open project/i })).toBeInTheDocument();
  });

  it("button click calls onOpenProject callback", async () => {
    const onOpenProject = vi.fn();
    render(EmptyState, { props: { onOpenProject } });

    const button = screen.getByRole("button", { name: /open project/i });
    await fireEvent.click(button);

    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("button is keyboard accessible (focusable)", async () => {
    render(EmptyState, { props: defaultProps });

    const button = screen.getByRole("button", { name: /open project/i });
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  describe("shortcut mode", () => {
    it("should-show-O-in-empty-state: shows O hint when shortcut mode active", () => {
      render(EmptyState, {
        props: { ...defaultProps, shortcutModeActive: true },
      });

      expect(screen.getByText("O")).toBeInTheDocument();
    });

    it("should-hide-O-in-empty-state: hides O hint when shortcut mode inactive", () => {
      render(EmptyState, {
        props: { ...defaultProps, shortcutModeActive: false },
      });

      expect(screen.queryByText("O")).not.toBeInTheDocument();
    });
  });
});
