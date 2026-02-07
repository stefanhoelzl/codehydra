// @vitest-environment node
/**
 * Integration tests for set-mode operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * including previousMode capture in the hook handler and event emission.
 *
 * Test plan items covered:
 * #8:  set-mode changes mode and captures previousMode
 * #9:  set-mode emits ui:mode-changed with mode and previousMode
 * #13: IPC event bridge forwards ui:mode-changed through apiRegistry.emit()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  SetModeOperation,
  SET_MODE_OPERATION_ID,
  INTENT_SET_MODE,
  EVENT_MODE_CHANGED,
} from "./set-mode";
import type { SetModeIntent, SetModeHookContext, ModeChangedEvent } from "./set-mode";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
import { createIpcEventBridge } from "../modules/ipc-event-bridge";
import type { UIMode } from "../../shared/ipc";

// =============================================================================
// Mock ApiRegistry for IpcEventBridge
// =============================================================================

interface MockApiRegistry {
  emit: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getInterface: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function createMockApiRegistry(): MockApiRegistry {
  return {
    emit: vi.fn(),
    register: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    getInterface: vi.fn(),
    dispose: vi.fn(),
  };
}

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface MockViewManager {
  currentMode: UIMode;
  setMode(mode: UIMode): void;
  getMode(): UIMode;
}

function createMockViewManager(initialMode: UIMode = "workspace"): MockViewManager {
  return {
    currentMode: initialMode,
    setMode(mode: UIMode): void {
      this.currentMode = mode;
    },
    getMode(): UIMode {
      return this.currentMode;
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  viewManager: MockViewManager;
  mockApiRegistry: MockApiRegistry;
}

function createTestSetup(opts?: { initialMode?: UIMode; withIpcEventBridge?: boolean }): TestSetup {
  const viewManager = createMockViewManager(opts?.initialMode ?? "workspace");

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_SET_MODE, new SetModeOperation());

  // Set mode hook handler module
  const setModeModule: IntentModule = {
    hooks: {
      [SET_MODE_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const intent = ctx.intent as SetModeIntent;
            const previousMode = viewManager.getMode();
            viewManager.setMode(intent.payload.mode);
            (ctx as SetModeHookContext).previousMode = previousMode;
          },
        },
      },
    },
  };

  // Optionally wire IpcEventBridge
  const mockApiRegistry = createMockApiRegistry();
  const modules: IntentModule[] = [setModeModule];
  if (opts?.withIpcEventBridge) {
    const ipcEventBridge = createIpcEventBridge(
      mockApiRegistry as unknown as import("../api/registry-types").IApiRegistry
    );
    modules.push(ipcEventBridge);
  }

  wireModules(modules, hookRegistry, dispatcher);

  return { dispatcher, viewManager, mockApiRegistry };
}

// =============================================================================
// Helpers
// =============================================================================

function setModeIntent(mode: UIMode): SetModeIntent {
  return {
    type: INTENT_SET_MODE,
    payload: { mode },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("SetMode Operation", () => {
  describe("changes mode and captures previousMode (#8)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({ initialMode: "workspace" });
    });

    it("changes viewManager mode to shortcut", async () => {
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(setModeIntent("shortcut"));

      expect(viewManager.currentMode).toBe("shortcut");
    });

    it("changes viewManager mode to dialog", async () => {
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(setModeIntent("dialog"));

      expect(viewManager.currentMode).toBe("dialog");
    });

    it("changes viewManager mode to hover", async () => {
      const { dispatcher, viewManager } = setup;

      await dispatcher.dispatch(setModeIntent("hover"));

      expect(viewManager.currentMode).toBe("hover");
    });
  });

  describe("emits ui:mode-changed event (#9)", () => {
    it("emits event with correct mode and previousMode", async () => {
      const setup = createTestSetup({ initialMode: "workspace" });
      const { dispatcher } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_MODE_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(setModeIntent("shortcut"));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as ModeChangedEvent;
      expect(event.type).toBe(EVENT_MODE_CHANGED);
      expect(event.payload.mode).toBe("shortcut");
      expect(event.payload.previousMode).toBe("workspace");
    });

    it("captures previousMode from non-workspace initial state", async () => {
      const setup = createTestSetup({ initialMode: "shortcut" });
      const { dispatcher } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_MODE_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(setModeIntent("workspace"));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as ModeChangedEvent;
      expect(event.payload.mode).toBe("workspace");
      expect(event.payload.previousMode).toBe("shortcut");
    });

    it("emits event even when mode is same as current", async () => {
      const setup = createTestSetup({ initialMode: "workspace" });
      const { dispatcher } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_MODE_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(setModeIntent("workspace"));

      // Domain event is emitted regardless - idempotency is ViewManager's responsibility
      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as ModeChangedEvent;
      expect(event.payload.mode).toBe("workspace");
      expect(event.payload.previousMode).toBe("workspace");
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents mode change and event (#14)", async () => {
      const setup = createTestSetup({ initialMode: "workspace" });
      const { dispatcher, viewManager } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_MODE_CHANGED, (event) => {
        receivedEvents.push(event);
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      dispatcher.addInterceptor(cancelInterceptor);

      const result = await dispatcher.dispatch(setModeIntent("shortcut"));

      expect(result).toBeUndefined();
      expect(viewManager.currentMode).toBe("workspace"); // Mode unchanged
      expect(receivedEvents).toHaveLength(0); // No event emitted
    });
  });

  describe("IpcEventBridge forwarding (#13)", () => {
    it("forwards ui:mode-changed to apiRegistry.emit", async () => {
      const setup = createTestSetup({
        initialMode: "workspace",
        withIpcEventBridge: true,
      });
      const { dispatcher, mockApiRegistry } = setup;

      await dispatcher.dispatch(setModeIntent("shortcut"));

      expect(mockApiRegistry.emit).toHaveBeenCalledWith("ui:mode-changed", {
        mode: "shortcut",
        previousMode: "workspace",
      });
    });

    it("forwards correct previousMode from non-workspace initial state", async () => {
      const setup = createTestSetup({
        initialMode: "shortcut",
        withIpcEventBridge: true,
      });
      const { dispatcher, mockApiRegistry } = setup;

      await dispatcher.dispatch(setModeIntent("workspace"));

      expect(mockApiRegistry.emit).toHaveBeenCalledWith("ui:mode-changed", {
        mode: "workspace",
        previousMode: "shortcut",
      });
    });

    it("does not forward when interceptor cancels", async () => {
      const setup = createTestSetup({
        initialMode: "workspace",
        withIpcEventBridge: true,
      });
      const { dispatcher, mockApiRegistry } = setup;

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      dispatcher.addInterceptor(cancelInterceptor);

      await dispatcher.dispatch(setModeIntent("shortcut"));

      expect(mockApiRegistry.emit).not.toHaveBeenCalled();
    });
  });
});
