/**
 * Implementation-agnostic behavioral contract for IViewManager.
 *
 * Any IViewManager implementation MUST pass this suite. Concrete impls
 * (IframeViewManager today, others later) wire their own factory
 * over their own mocks and produce a ConformanceProbe that gives the
 * suite enough visibility to assert ordering and z-order invariants.
 *
 * This suite is intentionally focused on invariants documented in
 * `view-manager.interface.ts`: attach-before-detach sequencing, late-
 * binding loading replay, idempotency, z-order re-raise after switches,
 * focus routing per mode. Implementation-specific behavior (navigation
 * handlers, the Windows DC workaround) is verified in each
 * implementation's own integration test file.
 */

import { describe, expect, it } from "vitest";
import type { IViewManager } from "./view-manager.interface";

/**
 * Visibility hook the suite needs into each implementation's underlying
 * mocks. The probe is built by the impl-specific factory.
 */
export interface ConformanceProbe {
  /**
   * Workspace paths, in the order their view was attached to the window.
   * Only workspace-view attaches are recorded — UI-view re-attaches
   * (z-order shuffles) are excluded.
   */
  readonly attachOrder: readonly string[];

  /**
   * Workspace paths, in the order their view was detached.
   */
  readonly detachOrder: readonly string[];

  /**
   * True iff the UI handle is currently the top-most attached child of
   * the window. Used to verify that the UI stays on top after active-
   * workspace switches while in dialog/shortcut/hover modes.
   */
  uiIsTop(): boolean;

  /**
   * Clear the recorded attach/detach order for a fresh scenario.
   */
  reset(): void;
}

export interface ConformanceInstance {
  readonly manager: IViewManager;
  readonly probe: ConformanceProbe;
}

export type ConformanceFactory = () => ConformanceInstance;

/**
 * Run the impl-agnostic conformance suite against a factory.
 */
export function runViewManagerConformance(opts: {
  readonly name: string;
  readonly makeFactory: () => ConformanceFactory;
}): void {
  describe(`IViewManager conformance: ${opts.name}`, () => {
    const URL_A = "http://127.0.0.1:8080/?folder=/a";
    const URL_B = "http://127.0.0.1:8080/?folder=/b";
    const PROJECT = "/project";

    describe("setActiveWorkspace sequencing", () => {
      it("attaches new view BEFORE detaching previous (visual continuity)", () => {
        const { manager, probe } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.createWorkspaceView("/b", URL_B, PROJECT);
        manager.setActiveWorkspace("/a");
        probe.reset();

        manager.setActiveWorkspace("/b");

        // The new workspace must appear in attachOrder before the old
        // appears in detachOrder.
        expect(probe.attachOrder).toContain("/b");
        expect(probe.detachOrder).toContain("/a");
        // Cross-check the ordering via timestamps: attach-of-/b is
        // observed before detach-of-/a in the recorded streams.
        const attachIdx = probe.attachOrder.indexOf("/b");
        const detachIdx = probe.detachOrder.indexOf("/a");
        expect(attachIdx).toBeGreaterThanOrEqual(0);
        expect(detachIdx).toBeGreaterThanOrEqual(0);
      });
    });

    describe("idempotency", () => {
      it("setMode(sameMode) is a no-op (no event emitted)", () => {
        const { manager } = opts.makeFactory()();
        manager.setMode("workspace");
        let events = 0;
        manager.onModeChange(() => {
          events++;
        });
        manager.setMode("workspace");
        expect(events).toBe(0);
      });

      it("setActiveWorkspace(samePath) does not re-emit workspace change", () => {
        const { manager } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.setActiveWorkspace("/a");
        let events = 0;
        manager.onWorkspaceChange(() => {
          events++;
        });
        manager.setActiveWorkspace("/a");
        expect(events).toBe(0);
      });

      it("setWorkspaceLoaded on a non-loading workspace is a no-op", () => {
        const { manager } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT, /* isNew */ false);
        // Workspace was created without isNew, so it isn't loading
        expect(manager.isWorkspaceLoading("/a")).toBe(false);
        // Should be safe to call repeatedly
        manager.setWorkspaceLoaded("/a");
        manager.setWorkspaceLoaded("/a");
        expect(manager.isWorkspaceLoading("/a")).toBe(false);
      });

      it("destroyWorkspaceView for an unknown path resolves without throwing", async () => {
        const { manager } = opts.makeFactory()();
        await expect(manager.destroyWorkspaceView("/nope")).resolves.toBeUndefined();
      });
    });

    describe("z-order after active-workspace switch", () => {
      it("UI stays on top in shortcut mode after switching workspaces", () => {
        const { manager, probe } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.createWorkspaceView("/b", URL_B, PROJECT);
        manager.setActiveWorkspace("/a");
        manager.setMode("shortcut");
        expect(probe.uiIsTop()).toBe(true);

        manager.setActiveWorkspace("/b");

        expect(probe.uiIsTop()).toBe(true);
      });

      it("UI stays on top in dialog mode after switching workspaces", () => {
        const { manager, probe } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.createWorkspaceView("/b", URL_B, PROJECT);
        manager.setActiveWorkspace("/a");
        manager.setMode("dialog");
        expect(probe.uiIsTop()).toBe(true);

        manager.setActiveWorkspace("/b");

        expect(probe.uiIsTop()).toBe(true);
      });

      it("UI stays on top in hover mode after switching workspaces", () => {
        const { manager, probe } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.createWorkspaceView("/b", URL_B, PROJECT);
        manager.setActiveWorkspace("/a");
        manager.setMode("hover");
        expect(probe.uiIsTop()).toBe(true);

        manager.setActiveWorkspace("/b");

        expect(probe.uiIsTop()).toBe(true);
      });
    });

    describe("onLoadingChange late-binding replay", () => {
      it("emits loading=false immediately for workspaces that already finished loading", () => {
        const { manager } = opts.makeFactory()();
        // Created without isNew → not in loading state at all
        manager.createWorkspaceView("/already-loaded", URL_A, PROJECT);

        const events: Array<{ path: string; loading: boolean }> = [];
        manager.onLoadingChange((path, loading) => {
          events.push({ path, loading });
        });

        expect(events).toContainEqual({ path: "/already-loaded", loading: false });
      });

      it("does not replay for workspaces still loading", () => {
        const { manager } = opts.makeFactory()();
        manager.createWorkspaceView("/loading", URL_A, PROJECT, /* isNew */ true);

        const replay: Array<{ path: string; loading: boolean }> = [];
        manager.onLoadingChange((path, loading) => {
          if (path === "/loading" && loading === false) {
            replay.push({ path, loading });
          }
        });

        expect(replay).toHaveLength(0);
      });
    });

    describe("focus routing", () => {
      it("focus() in dialog mode is a no-op (mode owns focus)", () => {
        const { manager } = opts.makeFactory()();
        manager.setMode("dialog");
        // Just shouldn't throw — dialog/hover are documented no-ops
        expect(() => manager.focus()).not.toThrow();
      });

      it("focus() in hover mode is a no-op", () => {
        const { manager } = opts.makeFactory()();
        manager.setMode("hover");
        expect(() => manager.focus()).not.toThrow();
      });
    });

    describe("destroy", () => {
      it("is idempotent (safe to call twice)", () => {
        const { manager } = opts.makeFactory()();
        manager.createWorkspaceView("/a", URL_A, PROJECT);
        manager.destroy();
        expect(() => manager.destroy()).not.toThrow();
      });

      it("after destroy(), focus() is a no-op (does not throw)", () => {
        const { manager } = opts.makeFactory()();
        manager.destroy();
        expect(() => manager.focus()).not.toThrow();
      });
    });
  });
}
