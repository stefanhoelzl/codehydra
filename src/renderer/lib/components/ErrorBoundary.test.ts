/**
 * Tests for ErrorBoundary: it contains a render-time throw in its subtree,
 * swaps in a fallback instead of letting the error propagate, and reports the
 * error over the renderer log channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";

// Capture logger.error calls.
const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));

vi.mock("$lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockError,
  }),
}));

// Import after the mock is set up.
import ErrorBoundary from "./ErrorBoundary.svelte";

const okChildren = createRawSnippet(() => ({
  render: () => `<p data-testid="ok">content</p>`,
}));

const throwingChildren = createRawSnippet(() => ({
  render: () => {
    throw new Error("boom from child");
  },
}));

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders its children when nothing throws", () => {
    render(ErrorBoundary, { props: { label: "test", children: okChildren } });

    expect(screen.getByTestId("ok")).toHaveTextContent("content");
  });

  it("contains a render-time throw, showing the fallback and reporting it", () => {
    // Fake timers so the deferred telemetry re-throw never fires during the
    // test — here we only assert containment + logging.
    vi.useFakeTimers();

    expect(() =>
      render(ErrorBoundary, { props: { label: "panel:test", children: throwingChildren } })
    ).not.toThrow();

    // The fallback replaced the subtree; the throwing child is gone.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("ok")).not.toBeInTheDocument();

    // Reported over the log channel, tagged with the region label.
    expect(mockError).toHaveBeenCalledWith(
      'UI boundary "panel:test" caught an error',
      expect.objectContaining({ message: "boom from child" })
    );

    vi.clearAllTimers();
  });
});
