/**
 * Tests for the HibernatedOverlay component.
 *
 * The overlay shows a pause icon at rest; CSS swaps it to a play icon while
 * the indicator button is hovered (the swap itself is CSS-only and not
 * observable in happy-dom — the tests assert both icons are in the DOM).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { Api } from "@shared/electron-api";
import { createMockApi } from "../test-utils";

// Must be set before component import because $lib/api checks window.api
const mockApi: Api = createMockApi();
window.api = mockApi;

// Import after mock setup
import HibernatedOverlay from "./HibernatedOverlay.svelte";

describe("HibernatedOverlay", () => {
  const onWake = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders both pause and play icons inside the wake button", () => {
    const { container } = render(HibernatedOverlay, { props: { screenshot: null, onWake } });

    const indicator = container.querySelector(".indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator!.querySelector(".icon-pause vscode-icon")).toBeInTheDocument();
    expect(indicator!.querySelector(".icon-play vscode-icon")).toBeInTheDocument();
  });

  it("shows the hibernated label and wake hint", () => {
    render(HibernatedOverlay, { props: { screenshot: null, onWake } });

    expect(screen.getByText("Hibernated")).toBeInTheDocument();
    expect(screen.getByText(/Alt\+X H/)).toBeInTheDocument();
  });

  it("renders the inline screenshot when provided", () => {
    const dataUrl = "data:image/png;base64,UE5H";
    const { container } = render(HibernatedOverlay, { props: { screenshot: dataUrl, onWake } });

    const img = container.querySelector<HTMLImageElement>("img.screenshot");
    expect(img).toBeInTheDocument();
    expect(img!.src).toBe(dataUrl);
  });

  it("renders no screenshot image when null", () => {
    const { container } = render(HibernatedOverlay, { props: { screenshot: null, onWake } });

    expect(container.querySelector("img.screenshot")).not.toBeInTheDocument();
  });

  it("clicking the indicator calls onWake", async () => {
    render(HibernatedOverlay, { props: { screenshot: null, onWake } });

    const button = screen.getByRole("button", { name: /wake workspace/i });
    await fireEvent.click(button);

    expect(onWake).toHaveBeenCalled();
  });
});
