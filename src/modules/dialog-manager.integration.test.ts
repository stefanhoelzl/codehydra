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

    it("should include the surface on the open command when given", () => {
      const config = createConfig("Panel form");

      const handle = manager.open(config, { surface: "panel" });

      expect(sendToUI).toHaveBeenCalledWith(ApiIpcChannels.DIALOG_COMMAND, {
        action: "open",
        dialogId: handle.id,
        config,
        surface: "panel",
      } satisfies DialogCommand);
    });

    it("should omit the surface field by default", () => {
      const config = createConfig("Modal");

      manager.open(config);

      const command = sendToUI.mock.calls[0]![1] as DialogCommand;
      expect("surface" in command).toBe(false);
    });

    it("should not resend the surface on update (session property, set once)", () => {
      const handle = manager.open(createConfig("Panel"), { surface: "panel" });
      sendToUI.mockClear();

      handle.update(createConfig("Updated"));

      const command = sendToUI.mock.calls[0]![1] as DialogCommand;
      expect(command.action).toBe("update");
      expect("surface" in command).toBe(false);
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
        data: { agent: "claude" },
      };
      manager.routeEvent(event);

      await expect(promise).resolves.toEqual(event);
    });

    it("should only resolve once per call", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();
      manager.routeEvent({ dialogId: handle.id, actionId: "first" });
      manager.routeEvent({ dialogId: handle.id, actionId: "second" });

      await expect(promise).resolves.toMatchObject({ actionId: "first" });
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

      await expect(promise).resolves.toMatchObject({ actionId: "ok" });
    });

    it("should not timeout when no timeout is specified", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();

      // Resolve immediately — no timeout race
      manager.routeEvent({ dialogId: handle.id, actionId: "ok" });
      await expect(promise).resolves.toEqual(expect.objectContaining({ actionId: "ok" }));
    });
  });

  describe("onChange", () => {
    it("routes a change event to onChange listeners, not onEvent", () => {
      const handle = manager.open(createConfig("Test"));
      const onAction = vi.fn();
      const onChange = vi.fn();
      handle.onEvent(onAction);
      handle.onChange(onChange);

      const event: DialogUserEvent = {
        kind: "change",
        dialogId: handle.id,
        fieldId: "name",
        data: { name: "abc" },
      };
      manager.routeEvent(event);

      expect(onChange).toHaveBeenCalledWith(event);
      expect(onAction).not.toHaveBeenCalled();
    });

    it("routes an action event to onEvent listeners, not onChange", () => {
      const handle = manager.open(createConfig("Test"));
      const onAction = vi.fn();
      const onChange = vi.fn();
      handle.onEvent(onAction);
      handle.onChange(onChange);

      manager.routeEvent({ dialogId: handle.id, actionId: "ok" });

      expect(onAction).toHaveBeenCalledWith({ dialogId: handle.id, actionId: "ok" });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("supports unsubscribe", () => {
      const handle = manager.open(createConfig("Test"));
      const onChange = vi.fn();
      const unsub = handle.onChange(onChange);

      unsub();
      manager.routeEvent({ kind: "change", dialogId: handle.id, fieldId: "f", data: {} });

      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not deliver change events after close", () => {
      const handle = manager.open(createConfig("Test"));
      const onChange = vi.fn();
      handle.onChange(onChange);
      handle.close();

      manager.routeEvent({ kind: "change", dialogId: handle.id, fieldId: "f", data: {} });

      expect(onChange).not.toHaveBeenCalled();
    });

    it("nextEvent ignores change events and resolves on the next action", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();
      manager.routeEvent({ kind: "change", dialogId: handle.id, fieldId: "f", data: { f: "x" } });
      manager.routeEvent({ dialogId: handle.id, actionId: "go" });

      await expect(promise).resolves.toMatchObject({ actionId: "go" });
    });
  });

  describe("onDismiss", () => {
    it("routes a dismiss event to onDismiss listeners only", () => {
      const handle = manager.open(createConfig("Test"), { surface: "panel" });
      const onAction = vi.fn();
      const onChange = vi.fn();
      const onDismiss = vi.fn();
      handle.onEvent(onAction);
      handle.onChange(onChange);
      handle.onDismiss(onDismiss);

      const event: DialogUserEvent = { kind: "dismiss", dialogId: handle.id };
      manager.routeEvent(event);

      expect(onDismiss).toHaveBeenCalledWith(event);
      expect(onAction).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("supports unsubscribe", () => {
      const handle = manager.open(createConfig("Test"));
      const onDismiss = vi.fn();
      const unsub = handle.onDismiss(onDismiss);

      unsub();
      manager.routeEvent({ kind: "dismiss", dialogId: handle.id });

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("does not deliver dismiss events after close", () => {
      const handle = manager.open(createConfig("Test"));
      const onDismiss = vi.fn();
      handle.onDismiss(onDismiss);
      handle.close();

      manager.routeEvent({ kind: "dismiss", dialogId: handle.id });

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("nextEvent resolves on a dismiss event (callers loop if they need an action)", async () => {
      const handle = manager.open(createConfig("Test"));

      const promise = handle.nextEvent();
      manager.routeEvent({ kind: "dismiss", dialogId: handle.id });

      const result = await promise;
      expect(result.kind).toBe("dismiss");
    });

    it("nextEvent unsubscribes both channels once settled", async () => {
      const handle = manager.open(createConfig("Test"));

      const first = handle.nextEvent();
      manager.routeEvent({ dialogId: handle.id, actionId: "go" });
      await expect(first).resolves.toMatchObject({ actionId: "go" });

      // A later dismiss only settles the NEW wait, not stale listeners.
      const second = handle.nextEvent();
      manager.routeEvent({ kind: "dismiss", dialogId: handle.id });
      expect((await second).kind).toBe("dismiss");
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

    it("should log fieldId when a change event arrives for unknown dialog", () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        silly: vi.fn(),
      };
      const loggedManager = new DialogManager(sendToUI, logger);

      loggedManager.routeEvent({
        kind: "change",
        dialogId: "unknown-id",
        fieldId: "name",
        data: { name: "x" },
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "Dialog event for unknown dialog",
        expect.objectContaining({ dialogId: "unknown-id", kind: "change", fieldId: "name" })
      );
    });
  });
});
