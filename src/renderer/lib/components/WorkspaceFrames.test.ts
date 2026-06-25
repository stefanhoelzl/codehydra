// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
/**
 * Tests for the WorkspaceFrames component.
 *
 * Frames derive from the projects store: one iframe per workspace that has a
 * code-server URL and isn't hibernated; only the active workspace's frame is
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
import {
  setProjects,
  setActiveWorkspace,
  reset as resetProjects,
} from "$lib/stores/projects.svelte";
import { reset as resetUiMode } from "$lib/stores/ui-mode.svelte";
import type { Project } from "@shared/api/types";
import { asProjectId, createMockProject } from "@shared/test-fixtures";

interface FrameHooks {
  __chFocusActiveFrame?: () => void;
  __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
  __chReloadFrames?: () => void;
}

function makeProject(): Project {
  return createMockProject({
    id: asProjectId("test-12345678"),
    name: "test",
    path: "/projects/test",
    workspaces: [
      {
        name: "ws1",
        branch: "main",
        path: "/workspaces/ws1",
        url: "http://127.0.0.1:9000/?folder=/workspaces/ws1",
      },
      {
        name: "ws2",
        branch: "feature",
        path: "/workspaces/ws2",
        url: "http://127.0.0.1:9000/?folder=/workspaces/ws2",
      },
      {
        name: "sleeping",
        branch: "old",
        metadata: { hibernated: "true" },
        path: "/workspaces/sleeping",
        url: "http://127.0.0.1:9000/?folder=/workspaces/sleeping",
      },
      {
        name: "pending",
        branch: null,
        path: "/workspaces/__pending__",
        // no url — placeholder from workspace:loading
      },
    ],
  });
}

function frames(container: HTMLElement): HTMLIFrameElement[] {
  return [...container.querySelectorAll("iframe")];
}

describe("WorkspaceFrames", () => {
  beforeEach(() => {
    resetProjects();
    resetUiMode();
    document.body.innerHTML = "";
  });

  it("mounts an iframe per workspace with a URL, skipping hibernated and url-less ones", () => {
    setProjects([makeProject()]);
    const { container } = render(WorkspaceFrames);

    const els = frames(container);
    expect(els).toHaveLength(2);
    expect(els.map((el) => el.dataset.path).sort()).toEqual(["/workspaces/ws1", "/workspaces/ws2"]);
    expect(els[0]!.src).toContain("folder=/workspaces/ws1");
  });

  it("marks only the active workspace's frame as active", async () => {
    setProjects([makeProject()]);
    setActiveWorkspace("/workspaces/ws2");
    const { container } = render(WorkspaceFrames);

    const active = frames(container).filter((el) => el.classList.contains("active"));
    expect(active).toHaveLength(1);
    expect(active[0]!.dataset.path).toBe("/workspaces/ws2");
  });

  it("shows no active frame when no workspace is active", () => {
    setProjects([makeProject()]);
    const { container } = render(WorkspaceFrames);

    expect(frames(container).some((el) => el.classList.contains("active"))).toBe(false);
  });

  it("unmounts a frame when its workspace becomes hibernated", async () => {
    const project = makeProject();
    setProjects([project]);
    const { container, rerender } = render(WorkspaceFrames);
    expect(frames(container)).toHaveLength(2);

    setProjects([
      {
        ...project,
        workspaces: project.workspaces.map((w) =>
          w.path === "/workspaces/ws2" ? { ...w, metadata: { hibernated: "true" } } : w
        ),
      },
    ]);
    await rerender({});

    expect(frames(container)).toHaveLength(1);
    expect(frames(container)[0]!.dataset.path).toBe("/workspaces/ws1");
  });

  it("registers the main-process window hooks and removes them on unmount", () => {
    setProjects([makeProject()]);
    const hooks = window as FrameHooks;
    const { unmount } = render(WorkspaceFrames);

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

  it("__chActiveFrameRect returns null when no workspace is active", () => {
    setProjects([makeProject()]);
    render(WorkspaceFrames);

    const hooks = window as FrameHooks;
    expect(hooks.__chActiveFrameRect!()).toBeNull();
  });
});
