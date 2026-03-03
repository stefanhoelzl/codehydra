/**
 * Tests for the OpenProjectErrorDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import OpenProjectErrorDialog from "./OpenProjectErrorDialog.svelte";

describe("OpenProjectErrorDialog component", () => {
  const defaultProps = {
    open: true,
    errorMessage: "Path is not a git repository: /test/folder",
    onRetry: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("structure", () => {
    it("uses Dialog base component", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it('renders title "Could Not Open Project"', async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText("Could Not Open Project")).toBeInTheDocument();
    });

    it("renders error message", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByText("Path is not a git repository: /test/folder")).toBeInTheDocument();
    });

    it("renders Cancel and Select Different Folder buttons", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /select different folder/i })).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("error message has role=alert for screen readers", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent("Path is not a git repository: /test/folder");
    });

    it("Select Different Folder button receives initial focus", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const retryButton = screen.getByRole("button", { name: /select different folder/i });
      expect(retryButton).toHaveFocus();
    });
  });

  describe("user interactions", () => {
    it("calls onRetry when Select Different Folder button is clicked", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const retryButton = screen.getByRole("button", { name: /select different folder/i });
      await fireEvent.click(retryButton);

      expect(defaultProps.onRetry).toHaveBeenCalled();
    });

    it("calls onClose when Cancel button is clicked", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await fireEvent.click(cancelButton);

      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("calls onClose when Escape is pressed", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      await fireEvent.keyDown(document.body, { key: "Escape" });

      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("does not call onClose when clicking overlay", async () => {
      render(OpenProjectErrorDialog, { props: defaultProps });
      await vi.runAllTimersAsync();

      const overlay = screen.getByTestId("dialog-overlay");
      await fireEvent.click(overlay);

      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  describe("closed state", () => {
    it("does not render when open is false", async () => {
      render(OpenProjectErrorDialog, {
        props: { ...defaultProps, open: false },
      });
      await vi.runAllTimersAsync();

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
