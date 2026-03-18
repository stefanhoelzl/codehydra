// @vitest-environment node
/**
 * Integration tests for DialogManager.
 *
 * Tests verify: open/update/close commands sent to UI, event routing to handles,
 * nextEvent promise resolution, and closed promise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DialogManager } from "./dialog-manager";
import type { DialogConfig, DialogCommand, DialogUserEvent } from "../shared/dialog-types";
import { ApiIpcChannels } from "../shared/ipc";

function createConfig(heading: string): DialogConfig {
  return {
    sections: [{ type: "text", content: heading, style: "heading" }],
  };
}

describe("DialogManager", () => {
  let sendToUI: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;
  let manager: DialogManager;

  beforeEach(() => {
    sendToUI = vi.fn<(channel: string, ...args: unknown[]) => void>();
    manager = new DialogManager(sendToUI);
  });

  describe("open", () => {
    it("should send an open command to the UI", () => {
      const config = createConfig("Hello");

      const handle = manager.open(config);

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.DIALOG_COMMAND, {
        action: "open",
        dialogId: handle.id,
        config,
      } satisfies DialogCommand);
    });

    it("should generate unique dialog IDs", () => {
      const h1 = manager.open(createConfig("A"));
      const h2 = manager.open(createConfig("B"));

      expect(h1.id).not.toBe(h2.id);
    });
  });

  describe("update", () => {
    it("should send an update command to the UI", () => {
      const handle = manager.open(createConfig("Initial"));
      sendToUI.mockClear();

      const newConfig = createConfig("Updated");
      handle.update(newConfig);

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.DIALOG_COMMAND, {
        action: "update",
        dialogId: handle.id,
        config: newConfig,
      } satisfies DialogCommand);
    });

    it("should not send after close", () => {
      const handle = manager.open(createConfig("Test"));
      handle.close();
      sendToUI.mockClear();

      handle.update(createConfig("After close"));

      expect(sendToUI).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should send a close command to the UI", () => {
      const handle = manager.open(createConfig("Test"));
      sendToUI.mockClear();

      handle.close();

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.DIALOG_COMMAND, {
        action: "close",
        dialogId: handle.id,
      } satisfies DialogCommand);
    });

    it("should resolve the closed promise", async () => {
      const handle = manager.open(createConfig("Test"));

      handle.close();

      await expect(handle.closed).resolves.toBeUndefined();
    });

    it("should be idempotent", () => {
      const handle = manager.open(createConfig("Test"));
      handle.close();
      sendToUI.mockClear();

      handle.close();

      expect(sendToUI).not.toHaveBeenCalled();
    });
  });

  describe("routeEvent", () => {
    it("should deliver events to the correct handle", () => {
      const handle1 = manager.open(createConfig("A"));
      const handle2 = manager.open(createConfig("B"));
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      handle1.onEvent(handler1);
      handle2.onEvent(handler2);

      const event: DialogUserEvent = {
        dialogId: handle1.id,
        actionId: "retry",
      };
      manager.routeEvent(event);

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).not.toHaveBeenCalled();
    });

    it("should not throw for unknown dialog IDs", () => {
      expect(() => manager.routeEvent({ dialogId: "unknown", actionId: "test" })).not.toThrow();
    });

    it("should not deliver events after close", () => {
      const handle = manager.open(createConfig("Test"));
      const handler = vi.fn();
      handle.onEvent(handler);
      handle.close();

      manager.routeEvent({ dialogId: handle.id, actionId: "test" });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onEvent", () => {
    it("should support unsubscribe", () => {
      const handle = manager.open(createConfig("Test"));
      const handler = vi.fn();
      const unsub = handle.onEvent(handler);

      unsub();
      manager.routeEvent({ dialogId: handle.id, actionId: "test" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should support multiple listeners", () => {
      const handle = manager.open(createConfig("Test"));
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      handle.onEvent(handler1);
      handle.onEvent(handler2);

      const event: DialogUserEvent = { dialogId: handle.id, actionId: "ok" };
      manager.routeEvent(event);

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });
  });

  describe("nextEvent", () => {
    it("should resolve with the next event", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();

      const event: DialogUserEvent = {
        dialogId: handle.id,
        actionId: "continue",
        data: { selection: "claude" },
      };
      manager.routeEvent(event);

      await expect(promise).resolves.toEqual(event);
    });

    it("should only resolve once per call", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();
      manager.routeEvent({ dialogId: handle.id, actionId: "first" });
      manager.routeEvent({ dialogId: handle.id, actionId: "second" });

      const result = await promise;
      expect(result.actionId).toBe("first");
    });

    it("should reject after timeout when no event arrives", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent(50);

      await expect(promise).rejects.toThrow("no response within 50ms");
    });

    it("should resolve before timeout when event arrives in time", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent(5000);
      manager.routeEvent({ dialogId: handle.id, actionId: "ok" });

      const result = await promise;
      expect(result.actionId).toBe("ok");
    });

    it("should not timeout when no timeout is specified", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();

      // Resolve immediately — no timeout race
      manager.routeEvent({ dialogId: handle.id, actionId: "ok" });
      await expect(promise).resolves.toEqual(expect.objectContaining({ actionId: "ok" }));
    });
  });

  describe("routeEvent with logger", () => {
    it("should log when event arrives for unknown dialog", () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        silly: vi.fn(),
      };
      const loggedManager = new DialogManager(sendToUI, logger);

      loggedManager.routeEvent({ dialogId: "unknown-id", actionId: "click" });

      expect(logger.debug).toHaveBeenCalledWith(
        "Dialog event for unknown dialog",
        expect.objectContaining({ dialogId: "unknown-id", actionId: "click" })
      );
    });
  });
});
