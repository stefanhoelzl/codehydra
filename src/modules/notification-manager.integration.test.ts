// @vitest-environment node
/**
 * Integration tests for NotificationManager command buffering.
 *
 * The renderer's NotificationHost only subscribes once MainView mounts, so
 * commands sent earlier must be buffered and flushed on markUIReady().
 */

import { describe, it, expect, vi } from "vitest";
import { NotificationManager } from "./notification-manager";
import { ApiIpcChannels } from "../shared/ipc";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { NotificationConfig } from "../shared/notification-types";

const CONFIG: NotificationConfig = {
  type: "info",
  title: "Test",
  message: "Test message",
  dismissible: true,
};

function createManager() {
  const sendToUI = vi.fn<(channel: string, ...args: unknown[]) => void>();
  const manager = new NotificationManager({ sendToUI } as unknown as IViewManager);
  return { manager, sendToUI };
}

describe("NotificationManager buffering", () => {
  it("buffers commands until markUIReady, then flushes in order", () => {
    const { manager, sendToUI } = createManager();

    const handle = manager.open(CONFIG);
    const updated: NotificationConfig = { ...CONFIG, title: "Updated" };
    handle.update(updated);

    expect(sendToUI).not.toHaveBeenCalled();

    manager.markUIReady();

    expect(sendToUI.mock.calls).toEqual([
      [
        ApiIpcChannels.NOTIFICATION_COMMAND,
        { action: "open", notificationId: handle.id, config: CONFIG },
      ],
      [
        ApiIpcChannels.NOTIFICATION_COMMAND,
        { action: "update", notificationId: handle.id, config: updated },
      ],
    ]);
  });

  it("skips notifications opened and closed while buffered", () => {
    const { manager, sendToUI } = createManager();

    const transient = manager.open(CONFIG);
    transient.close();
    const survivor = manager.open(CONFIG);

    manager.markUIReady();

    expect(sendToUI).toHaveBeenCalledTimes(1);
    expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.NOTIFICATION_COMMAND, {
      action: "open",
      notificationId: survivor.id,
      config: CONFIG,
    });
  });

  it("sends directly after markUIReady", () => {
    const { manager, sendToUI } = createManager();
    manager.markUIReady();

    const handle = manager.open(CONFIG);
    handle.close();

    expect(sendToUI.mock.calls).toEqual([
      [
        ApiIpcChannels.NOTIFICATION_COMMAND,
        { action: "open", notificationId: handle.id, config: CONFIG },
      ],
      [ApiIpcChannels.NOTIFICATION_COMMAND, { action: "close", notificationId: handle.id }],
    ]);
  });

  it("markUIReady is idempotent", () => {
    const { manager, sendToUI } = createManager();

    manager.open(CONFIG);
    manager.markUIReady();
    manager.markUIReady();

    expect(sendToUI).toHaveBeenCalledTimes(1);
  });
});
