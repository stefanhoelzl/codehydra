// @vitest-environment node
/**
 * Integration tests for FrameWatchdogModule.
 *
 * The transport is a behavioral fake that lets a test play sidekick connects
 * and disconnects; the presenter is a fake `reloadFrame` that answers whether a
 * frame was mounted. Timers are faked so the grace period costs nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFrameWatchdogModule, RECONNECT_GRACE_MS } from "./frame-watchdog-module";
import type { WorkspaceDisconnect } from "./plugin-server-module";
import { EVENT_IDE_SERVER_RESTARTED, EVENT_IDE_SERVER_SESSIONS_STALE } from "../intents/app-resume";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { HookContext } from "../intents/lib/operation";
import { createMockLogger } from "../boundaries/platform/logging";

const WS = "/projects/app/.worktrees/ios";

function createSetup(options?: { mounted?: boolean }) {
  const connectListeners = new Set<(workspacePath: string) => void>();
  const disconnectListeners = new Set<(disconnect: WorkspaceDisconnect) => void>();
  const transport = {
    onWorkspaceConnected(listener: (workspacePath: string) => void): () => void {
      connectListeners.add(listener);
      return () => connectListeners.delete(listener);
    },
    onWorkspaceDisconnected(listener: (disconnect: WorkspaceDisconnect) => void): () => void {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
  };
  const reloadFrame = vi.fn<(workspacePath: string) => boolean>(() => options?.mounted ?? true);
  const logger = createMockLogger();
  const module = createFrameWatchdogModule({ transport, frames: { reloadFrame }, logger });

  return {
    module,
    reloadFrame,
    logger,
    connect(workspacePath = WS): void {
      for (const listener of [...connectListeners]) listener(workspacePath);
    },
    disconnect(
      reason = "client namespace disconnect",
      initiatedByUs = false,
      workspacePath = WS
    ): void {
      for (const listener of [...disconnectListeners]) {
        listener({ workspacePath, reason, initiatedByUs });
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
      expect.objectContaining({ workspace: WS, reason: "client namespace disconnect" })
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
      expect.objectContaining({ workspace: WS })
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
      expect.objectContaining({ workspace: WS })
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
    const other = "/projects/app/.worktrees/android";
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
});
