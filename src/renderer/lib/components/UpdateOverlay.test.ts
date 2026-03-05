/**
 * Tests for the UpdateOverlay component.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import UpdateOverlay from "./UpdateOverlay.svelte";

describe("UpdateOverlay component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("choice mode", () => {
    const defaultProps = {
      mode: "choice" as const,
      version: "2.1.0",
      percent: 0,
      onchoice: vi.fn(),
      oncancel: vi.fn(),
    };

    it("renders heading and version", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByRole("heading", { name: /update available/i })).toBeInTheDocument();
      expect(screen.getByText(/Version 2\.1\.0/)).toBeInTheDocument();
    });

    it("renders all four choice buttons", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByText("Always")).toBeInTheDocument();
      expect(screen.getByText("Yes")).toBeInTheDocument();
      expect(screen.getByText("Skip")).toBeInTheDocument();
      expect(screen.getByText("Never")).toBeInTheDocument();
    });

    it("clicking Always fires onchoice with 'always'", async () => {
      const onchoice = vi.fn();
      render(UpdateOverlay, { props: { ...defaultProps, onchoice } });

      await fireEvent.click(screen.getByText("Always"));
      expect(onchoice).toHaveBeenCalledWith("always");
    });

    it("clicking Yes fires onchoice with 'yes'", async () => {
      const onchoice = vi.fn();
      render(UpdateOverlay, { props: { ...defaultProps, onchoice } });

      await fireEvent.click(screen.getByText("Yes"));
      expect(onchoice).toHaveBeenCalledWith("yes");
    });

    it("clicking Skip fires onchoice with 'skip'", async () => {
      const onchoice = vi.fn();
      render(UpdateOverlay, { props: { ...defaultProps, onchoice } });

      await fireEvent.click(screen.getByText("Skip"));
      expect(onchoice).toHaveBeenCalledWith("skip");
    });

    it("clicking Never fires onchoice with 'never'", async () => {
      const onchoice = vi.fn();
      render(UpdateOverlay, { props: { ...defaultProps, onchoice } });

      await fireEvent.click(screen.getByText("Never"));
      expect(onchoice).toHaveBeenCalledWith("never");
    });

    it("has dialog role", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("downloading mode", () => {
    const defaultProps = {
      mode: "downloading" as const,
      version: "2.1.0",
      percent: 52,
      onchoice: vi.fn(),
      oncancel: vi.fn(),
    };

    it("renders downloading heading and version", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByRole("heading", { name: /updating codehydra/i })).toBeInTheDocument();
      expect(screen.getByText(/Downloading version 2\.1\.0\.\.\./)).toBeInTheDocument();
    });

    it("renders progress bar with correct percentage", () => {
      render(UpdateOverlay, { props: defaultProps });

      const progressBar = screen.getByRole("progressbar");
      expect(progressBar).toHaveAttribute("aria-valuenow", "52");
      expect(screen.getByText("52%")).toBeInTheDocument();
    });

    it("renders Cancel button", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("clicking Cancel fires oncancel", async () => {
      const oncancel = vi.fn();
      render(UpdateOverlay, { props: { ...defaultProps, oncancel } });

      await fireEvent.click(screen.getByText("Cancel"));
      expect(oncancel).toHaveBeenCalledTimes(1);
    });

    it("shows restart message", () => {
      render(UpdateOverlay, { props: defaultProps });

      expect(screen.getByText(/restart automatically/)).toBeInTheDocument();
    });
  });
});
