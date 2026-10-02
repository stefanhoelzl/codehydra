// @vitest-environment node
/**
 * Integration tests for FrameWatchdogModule.
 *
 * The transport is a behavioral fake that lets a test play sidekick connects
 * and disconnects; the presenter is a fake `reloadFrame` that answers whether a
 * frame was mounted; the view manager is a fake whose dead-frame list a test
 * sets, as if the frames' renderer process had died. Timers are faked so the
 * grace period and the poll cost nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createFrameWatchdogModule,
  RECONNECT_GRACE_MS,
  RENDERER_POLL_MS,
} from "./frame-watchdog-module";
import type { WorkspaceDisconnect } from "./api-server-module";
import { EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE } from "../intents/app-resume";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { HookContext } from "../intents/lib/operation";
import { createMockLogger } from "../boundaries/platform/logging";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";
import type { WorkspaceRef } from "../intents/contract";

const WS = makeWorkspaceRef(projectRefFor("/projects/app"), "ios");

function createSetup(options?: { mounted?: boolean }) {
  const connectListeners = new Set<(workspaceRef: WorkspaceRef) => void>();
  const disconnectListeners = new Set<(disconnect: WorkspaceDisconnect) => void>();
  const transport = {
    onWorkspaceConnected(listener: (workspaceRef: WorkspaceRef) => void): () => void {
      connectListeners.add(listener);
      return () => connectListeners.delete(listener);
    },
    onWorkspaceDisconnected(listener: (disconnect: WorkspaceDisconnect) => void): () => void {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
  };
  const reloadFrame = vi.fn<(workspaceRef: WorkspaceRef) => boolean>(
    () => options?.mounted ?? true
  );
  let deadFrameIds: readonly number[] = [];
  const renderer = {
    getDeadFrameIds: (): readonly number[] => deadFrameIds,
    reloadFrames: vi.fn<() => void>(),
  };
  const logger = createMockLogger();
  const module = createFrameWatchdogModule({
    transport,
    frames: { reloadFrame },
    renderer,
    logger,
  });

  return {
    module,
    reloadFrame,
    reloadFrames: renderer.reloadFrames,
    logger,
    /** Frames whose renderer process is gone, as the next poll will read them. */
    setDeadFrames(ids: readonly number[]): void {
      deadFrameIds = ids;
    },
    connect(workspaceRef = WS): void {
      for (const listener of [...connectListeners]) listener(workspaceRef);
    },
    disconnect(
      reason = "client namespace disconnect",
      initiatedByUs = false,
      workspaceRef = WS
    ): void {
      for (const listener of [...disconnectListeners]) {
        listener({ workspaceRef, reason, initiatedByUs });
      }
    },
    listenerCount: (): number => connectListeners.size + disconnectListeners.size,
  };
}

async function emit(module: IntentModule, type: string): Promise<void> {
  await module.events![type]!.handler({ type, payload: {} } as DomainEvent);
}

describe("FrameWatchdogModule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads the frame of a workspace whose IDE went away and did not come back", () => {
    const { reloadFrame, logger, disconnect } = createSetup();

    disconnect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    expect(reloadFrame).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(reloadFrame).toHaveBeenCalledExactlyOnceWith(WS);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reloaded its frame"),
      expect.objectContaining({ "scope.workspace": WS, reason: "client namespace disconnect" })
    );
  });

  it("leaves a workspace alone that reconnects within the grace period", () => {
    // A reload-window or an extension-host restart looks exactly like this.
    const { reloadFrame, disconnect, connect } = createSetup();

    disconnect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS / 2);
    connect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

    expect(reloadFrame).not.toHaveBeenCalled();
  });

  it("ignores a disconnect we caused (hibernate, delete, quit)", () => {
    const { reloadFrame, disconnect } = createSetup();

    disconnect("server namespace disconnect", true);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

    expect(reloadFrame).not.toHaveBeenCalled();
  });

  it("drops a pending verdict when we hang up on a workspace that was already waiting", () => {
    const { reloadFrame, disconnect } = createSetup();

    disconnect();
    disconnect("server namespace disconnect", true);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

    expect(reloadFrame).not.toHaveBeenCalled();
  });

  it("reloads only once when the reload does not bring the IDE back", () => {
    const { reloadFrame, logger, disconnect } = createSetup();

    disconnect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 10);

    expect(reloadFrame).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("still disconnected after reloading"),
      expect.objectContaining({ "scope.workspace": WS })
    );
  });

  it("logs the recovery when the reloaded frame reconnects", () => {
    const { logger, disconnect, connect } = createSetup();

    disconnect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    connect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("reconnected after its frame was reloaded"),
      expect.objectContaining({ "scope.workspace": WS })
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("still disconnected"),
      expect.anything()
    );
  });

  it("does not warn when the workspace no longer has a frame to reload", () => {
    const { reloadFrame, logger, disconnect } = createSetup({ mounted: false });

    disconnect();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

    expect(reloadFrame).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("tracks workspaces independently", () => {
    const other = makeWorkspaceRef(projectRefFor("/projects/app"), "android");
    const { reloadFrame, disconnect, connect } = createSetup();

    disconnect("client namespace disconnect", false, WS);
    disconnect("transport close", false, other);
    connect(other);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);

    expect(reloadFrame).toHaveBeenCalledExactlyOnceWith(WS);
  });

  it.each([EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE])(
    "drops pending verdicts on %s, which reloads every frame itself",
    async (event) => {
      const { module, reloadFrame, disconnect } = createSetup();

      disconnect("ping timeout");
      await emit(module, event);
      vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

      expect(reloadFrame).not.toHaveBeenCalled();
    }
  );

  it("unsubscribes and clears timers on shutdown", async () => {
    const { module, reloadFrame, disconnect, listenerCount } = createSetup();

    disconnect();
    await module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({} as HookContext);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 4);

    expect(reloadFrame).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
  });

  describe("renderer process", () => {
    /** A setup whose poll is running, as after app:start. */
    async function startedSetup(): Promise<ReturnType<typeof createSetup>> {
      const setup = createSetup();
      await setup.module.hooks![APP_START_OPERATION_ID]!["start"]!.handler({} as HookContext);
      return setup;
    }

    it("does not poll before app:start", () => {
      const { reloadFrames, setDeadFrames } = createSetup();

      setDeadFrames([2]);
      vi.advanceTimersByTime(RENDERER_POLL_MS * 5);

      expect(reloadFrames).not.toHaveBeenCalled();
    });

    it("reloads every frame once any frame's renderer is gone", async () => {
      const { reloadFrames, setDeadFrames, logger } = await startedSetup();

      setDeadFrames([2, 3]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);

      expect(reloadFrames).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Workspace renderer process died; reloading every workspace frame",
        { deadFrames: 2 }
      );
    });

    it("does nothing while every frame is alive", async () => {
      const { reloadFrames } = await startedSetup();

      vi.advanceTimersByTime(RENDERER_POLL_MS * 5);

      expect(reloadFrames).not.toHaveBeenCalled();
    });

    it("does not reload again while the reloaded frames are still coming up", async () => {
      // A reloaded frame reads dead until its new page commits.
      const { reloadFrames, setDeadFrames, logger } = await startedSetup();

      setDeadFrames([2]);
      vi.advanceTimersByTime(RENDERER_POLL_MS * 3);

      expect(reloadFrames).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("reports frames still dead after the grace period, once, without reloading again", async () => {
      const { reloadFrames, setDeadFrames, logger } = await startedSetup();

      setDeadFrames([2]);
      vi.advanceTimersByTime(RENDERER_POLL_MS + RECONNECT_GRACE_MS * 3);

      expect(reloadFrames).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Workspace frames still dead after reloading them; leaving them",
        { frames: 1, graceMs: RECONNECT_GRACE_MS }
      );
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("recovers again when the renderer dies a second time", async () => {
      const { reloadFrames, setDeadFrames } = await startedSetup();

      setDeadFrames([2, 3]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);
      setDeadFrames([]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);
      setDeadFrames([2, 3]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);

      expect(reloadFrames).toHaveBeenCalledTimes(2);
    });

    it("reloads for a frame that died after an earlier reload", async () => {
      // Frame 4 was mounted into the replacement process, which then died too.
      const { reloadFrames, setDeadFrames } = await startedSetup();

      setDeadFrames([2]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);
      setDeadFrames([2, 4]);
      vi.advanceTimersByTime(RENDERER_POLL_MS);

      expect(reloadFrames).toHaveBeenCalledTimes(2);
    });

    it("stops polling on shutdown", async () => {
      const { module, reloadFrames, setDeadFrames } = await startedSetup();

      await module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({} as HookContext);
      setDeadFrames([2]);
      vi.advanceTimersByTime(RENDERER_POLL_MS * 5);

      expect(reloadFrames).not.toHaveBeenCalled();
    });
  });
});
