/**
 * Tests for ErrorBoundary: it contains a render-time throw in its subtree,
 * swaps in a fallback instead of letting the error propagate, and reports the
 * error over the renderer log channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";

import ErrorBoundary from "./ErrorBoundary.svelte";

/**
 * The real `$lib/logging` is used here rather than a module mock: it is
 * imported by four components, so a mock registered in this file alone would
 * bind whichever of them loads first. Its only side effect is
 * `window.api.emitEvent`, which we stub instead — the same seam
 * `src/renderer/lib/logging/index.test.ts` uses.
 */
const mockEmitEvent = vi.fn();

type WindowWithApi = { api?: { emitEvent: typeof mockEmitEvent } };

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
    (window as unknown as WindowWithApi).api = { emitEvent: mockEmitEvent };
  });

  afterEach(() => {
    delete (window as unknown as WindowWithApi).api;
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
    expect(mockEmitEvent).toHaveBeenCalledWith({
      kind: "log",
      level: "error",
      logger: "ui",
      message: 'UI boundary "panel:test" caught an error',
      context: expect.objectContaining({ message: "boom from child" }),
    });

    vi.clearAllTimers();
  });
});
