// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
/**
 * Tests for the WorkspaceFrames component.
 *
 * Frames come pre-filtered from the UiState snapshot (the presenter only
 * includes mountable workspaces); only the frame matching activeKey is
 * visible (.active). Focus side effects (rAF + contentWindow.focus) are not
 * observable in happy-dom — the tests cover mounting, visibility, and the
 * window hooks the main process calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";

// The ui-mode store (imported by the component) calls api.ui.setMode.
vi.mock("$lib/api", () => ({
  ui: { setMode: vi.fn().mockResolvedValue(undefined) },
}));

import WorkspaceFrames from "./WorkspaceFrames.svelte";
import { reset as resetUiMode } from "$lib/stores/ui-mode.svelte";

interface FrameHooks {
  __chFocusActiveFrame?: () => void;
  __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
  __chReloadFrames?: () => void;
}

const FRAMES = [
  { key: "test-12345678/ws1", url: "http://127.0.0.1:9000/?folder=/workspaces/ws1", title: "ws1" },
  { key: "test-12345678/ws2", url: "http://127.0.0.1:9000/?folder=/workspaces/ws2", title: "ws2" },
];

function frames(container: HTMLElement): HTMLIFrameElement[] {
  return [...container.querySelectorAll("iframe")];
}

describe("WorkspaceFrames", () => {
  beforeEach(() => {
    resetUiMode();
    document.body.innerHTML = "";
  });

  it("mounts one iframe per frame entry", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    const els = frames(container);
    expect(els).toHaveLength(2);
    expect(els.map((el) => el.dataset.key).sort()).toEqual([
      "test-12345678/ws1",
      "test-12345678/ws2",
    ]);
    expect(els[0]!.src).toContain("folder=/workspaces/ws1");
    expect(els[0]!.title).toBe("Workspace ws1");
  });

  it("marks only the active frame as active", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: "test-12345678/ws2" },
    });

    const active = frames(container).filter((el) => el.classList.contains("active"));
    expect(active).toHaveLength(1);
    expect(active[0]!.dataset.key).toBe("test-12345678/ws2");
  });

  it("shows no active frame when activeKey is null", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    expect(frames(container).some((el) => el.classList.contains("active"))).toBe(false);
  });

  it("unmounts a frame when it leaves the snapshot (hibernation)", async () => {
    const { container, rerender } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });
    expect(frames(container)).toHaveLength(2);

    await rerender({ frames: [FRAMES[0]!], activeKey: null });

    expect(frames(container)).toHaveLength(1);
    expect(frames(container)[0]!.dataset.key).toBe("test-12345678/ws1");
  });

  it("registers the main-process window hooks and removes them on unmount", () => {
    const hooks = window as FrameHooks;
    const { unmount } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    expect(typeof hooks.__chFocusActiveFrame).toBe("function");
    expect(typeof hooks.__chActiveFrameRect).toBe("function");
    expect(typeof hooks.__chReloadFrames).toBe("function");

    unmount();
    expect(hooks.__chFocusActiveFrame).toBeUndefined();
    expect(hooks.__chActiveFrameRect).toBeUndefined();
    expect(hooks.__chReloadFrames).toBeUndefined();
  });

  it("__chReloadFrames re-assigns the src of every mounted frame", () => {
    setProjects([makeProject()]);
    setActiveWorkspace("/workspaces/ws1");
    const { container } = render(WorkspaceFrames);

    // Re-assigning src forces a reload; spy on the setter of each frame while
    // keeping the original URL readable. Only the two mounted (non-hibernated,
    // url-bearing) frames should be touched.
    const tracked = frames(container).map((el) => {
      const original = el.src;
      const setter = vi.fn();
      Object.defineProperty(el, "src", {
        configurable: true,
        get: () => original,
        set: setter,
      });
      return { setter, original };
    });
    expect(tracked).toHaveLength(2);

    const hooks = window as FrameHooks;
    hooks.__chReloadFrames!();

    for (const { setter, original } of tracked) {
      expect(setter).toHaveBeenCalledWith(original);
    }
  });

  it("__chActiveFrameRect returns null when no frame is active", () => {
    render(WorkspaceFrames, { props: { frames: FRAMES, activeKey: null } });

    const hooks = window as FrameHooks;
    expect(hooks.__chActiveFrameRect!()).toBeNull();
  });
});
