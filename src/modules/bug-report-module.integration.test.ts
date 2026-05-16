// @vitest-environment node
/**
 * Integration tests for BugReportModule.
 *
 * Tests the bug report dialog flow triggered by shortcut:key-pressed "b".
 * Follows the same pattern as devtools-module.integration.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { createBugReportModule, type BugReportModuleDeps } from "./bug-report-module";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { INTENT_SUBMIT_BUG_REPORT } from "../intents/submit-bug-report";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import type { DialogHandle } from "./dialog-manager";
import type { DialogUserEvent, DialogConfig, DialogSection } from "../shared/dialog-types";
import type { ConfigKeyDefinition } from "../boundaries/platform/config-definition";

// =============================================================================
// Helpers
// =============================================================================

function createMockHandle(): DialogHandle & {
  _emitEvent(event: DialogUserEvent): void;
  _closedResolve: () => void;
} {
  const listeners = new Set<(event: DialogUserEvent) => void>();
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  return {
    id: "dlg-test",
    closed: closedPromise,
    update: vi.fn(),
    close: vi.fn(() => closedResolve()),
    onEvent: vi.fn((handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    nextEvent: vi.fn(),
    _emitEvent(event: DialogUserEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    _closedResolve: closedResolve,
  };
}

interface ConfigFixture {
  readonly definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly effective: Readonly<Record<string, unknown>>;
}

function defineKey(
  name: string,
  defaultValue: unknown,
  options?: { sensitive?: boolean }
): [string, ConfigKeyDefinition<unknown>] {
  return [
    name,
    {
      name,
      default: defaultValue,
      parse: () => undefined,
      validate: () => undefined,
      ...(options?.sensitive !== undefined && { sensitive: options.sensitive }),
    },
  ];
}

function createConfigFixture(overrides?: {
  entries?: ReadonlyArray<[string, ConfigKeyDefinition<unknown>]>;
  effective?: Readonly<Record<string, unknown>>;
}): ConfigFixture {
  const entries = overrides?.entries ?? [
    defineKey("agent", null),
    defineKey("log.level", "warn"),
    defineKey("telemetry.distinct-id", null, { sensitive: true }),
    defineKey("experimental.youtrack.token", null, { sensitive: true }),
  ];
  const definitions = new Map(entries);
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of definitions) defaults[key] = def.default;
  const effective = { ...defaults, ...(overrides?.effective ?? {}) };
  return { definitions, defaults, effective };
}

function createMockDeps(
  overrides?: Partial<BugReportModuleDeps> & { configFixture?: ConfigFixture }
) {
  const handle = createMockHandle();
  const { configFixture, ...rest } = overrides ?? {};
  const fixture = configFixture ?? createConfigFixture();

  return {
    handle,
    deps: {
      dialogManager: {
        open: vi.fn().mockReturnValue(handle),
        routeEvent: vi.fn(),
      },
      fileSystem: {
        readFile: vi.fn().mockImplementation((path: string) => {
          if (path === "/logs/test-session.log") {
            return Promise.resolve("test log content\nline 2\nline 3");
          }
          if (path === "/logs/electron.log") {
            return Promise.resolve("electron log content");
          }
          return Promise.reject(new Error("ENOENT"));
        }),
      },
      loggingService: {
        getLogFilePath: vi.fn().mockReturnValue("/logs/test-session.log"),
        getElectronLogFilePath: vi.fn().mockReturnValue("/logs/electron.log"),
      },
      dispatcher: {
        dispatch: vi.fn().mockResolvedValue(undefined),
      },
      config: {
        getDefinitions: () => fixture.definitions,
        getDefaults: () => fixture.defaults,
        getEffective: () => fixture.effective,
      },
      logger: createMockLogger(),
      ...rest,
    } as unknown as BugReportModuleDeps,
  };
}

function getDescriptionInitialValue(config: DialogConfig): string {
  const input = config.sections.find(
    (s: DialogSection): s is DialogSection & { type: "input" } => s.type === "input"
  );
  if (!input) throw new Error("no input section");
  return input.initialValue ?? "";
}

async function emitKeyEvent(
  module: ReturnType<typeof createBugReportModule>,
  key: string
): Promise<void> {
  const event: ShortcutKeyPressedEvent = {
    type: EVENT_SHORTCUT_KEY_PRESSED,
    payload: { key },
  };
  await module.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);
}

// =============================================================================
// Tests
// =============================================================================

describe("BugReportModule", () => {
  it("opens dialog on 'b' key press with correct config", async () => {
    const { deps } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");

    expect(deps.dialogManager.open).toHaveBeenCalledOnce();
    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    expect(config.sections[0]).toEqual({
      type: "text",
      content: "Report a Bug",
      style: "heading",
      icon: "bug",
    });
    expect(config.sections[1]).toMatchObject({
      type: "input",
      id: "description",
      multiline: true,
    });
    expect(config.sections[2]).toMatchObject({
      type: "text",
      style: "subtitle",
      content: expect.stringContaining("config") as unknown as string,
    });
    expect(config.sections[3]).toMatchObject({
      type: "text",
      style: "subtitle",
      content: expect.stringContaining("logs") as unknown as string,
    });
    expect(config.actions).toHaveLength(2);
  });

  it("prefills description with '# default configuration' when no overrides", async () => {
    const { deps } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");

    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    const initial = getDescriptionInitialValue(config);
    expect(initial).toContain("# describe your issue");
    expect(initial).toContain("----------- config -----------------");
    expect(initial).toContain("# default configuration");
    expect(initial).not.toContain("{");
  });

  it("places cursor on the empty line after the hint", async () => {
    const { deps } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");

    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    const input = config.sections.find(
      (s: DialogSection): s is DialogSection & { type: "input" } => s.type === "input"
    );
    expect(input?.cursorOffset).toBe("# describe your issue\n".length);
  });

  it("prefills description with JSON of non-default values", async () => {
    const fixture = createConfigFixture({
      effective: { agent: "claude", "log.level": "debug" },
    });
    const { deps } = createMockDeps({ configFixture: fixture });
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");

    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    const initial = getDescriptionInitialValue(config);
    expect(initial).toContain('"agent": "claude"');
    expect(initial).toContain('"log.level": "debug"');
    expect(initial).not.toContain("telemetry.distinct-id");
    expect(initial).not.toContain("# default configuration");
  });

  it("redacts sensitive keys in the prefilled block", async () => {
    const fixture = createConfigFixture({
      effective: {
        agent: "claude",
        "telemetry.distinct-id": "abc-123-real-uuid",
        "experimental.youtrack.token": "super-secret-token",
      },
    });
    const { deps } = createMockDeps({ configFixture: fixture });
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");

    const config = (deps.dialogManager.open as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DialogConfig;
    const initial = getDescriptionInitialValue(config);
    expect(initial).toContain('"telemetry.distinct-id": "<redacted>"');
    expect(initial).toContain('"experimental.youtrack.token": "<redacted>"');
    expect(initial).not.toContain("abc-123-real-uuid");
    expect(initial).not.toContain("super-secret-token");
    expect(initial).toContain('"agent": "claude"');
  });

  it("sends description verbatim on 'send', preserving user edits to the block", async () => {
    const { deps, handle } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "My edited report\n--- Config ---\n{}\n---" } },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            description: "My edited report\n--- Config ---\n{}\n---",
          }),
        })
      );
    });
  });

  it("ignores non-'b' keys", async () => {
    const { deps } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "d");
    await emitKeyEvent(module, "up");
    await emitKeyEvent(module, "enter");

    expect(deps.dialogManager.open).not.toHaveBeenCalled();
  });

  it("prevents multiple simultaneous dialogs", async () => {
    const { deps } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    await emitKeyEvent(module, "b");

    expect(deps.dialogManager.open).toHaveBeenCalledOnce();
  });

  it("dispatches SubmitBugReportIntent on 'send' action", async () => {
    const { deps, handle } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "It crashed" } },
    });

    // Wait for async readFile + dispatch
    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: INTENT_SUBMIT_BUG_REPORT,
          payload: {
            description: "It crashed",
            logs: "test log content\nline 2\nline 3",
            electronLogs: "electron log content",
          },
        })
      );
    });
    expect(handle.close).toHaveBeenCalled();
  });

  it("sends empty description when not provided", async () => {
    const { deps, handle } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: {},
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ description: "" }),
        })
      );
    });
  });

  it("closes dialog on 'cancel' action without dispatching", async () => {
    const { deps, handle } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "cancel",
    });

    expect(handle.close).toHaveBeenCalled();
    expect(deps.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("includes rotated archive log content alongside current log", async () => {
    const { deps, handle } = createMockDeps();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/logs/test-session.log") return Promise.resolve("CURRENT");
      if (path === "/logs/test-session.old.log") return Promise.resolve("ARCHIVE\n");
      return Promise.reject(new Error("ENOENT"));
    });
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "rotated" } },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ logs: "ARCHIVE\nCURRENT" }),
        })
      );
    });
  });

  it("attaches electron.log content alongside app log", async () => {
    const { deps, handle } = createMockDeps();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/logs/test-session.log") return Promise.resolve("APP");
      if (path === "/logs/electron.log") return Promise.resolve("CHROMIUM-NATIVE");
      return Promise.reject(new Error("ENOENT"));
    });
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "both logs" } },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            logs: "APP",
            electronLogs: "CHROMIUM-NATIVE",
          }),
        })
      );
    });
  });

  it("uses empty electronLogs when electron.log is missing", async () => {
    const { deps, handle } = createMockDeps();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/logs/test-session.log") return Promise.resolve("APP");
      return Promise.reject(new Error("ENOENT"));
    });
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "no electron yet" } },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ logs: "APP", electronLogs: "" }),
        })
      );
    });
  });

  it("handles log file read failure gracefully", async () => {
    const { deps, handle } = createMockDeps();
    (deps.fileSystem.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({
      dialogId: "dlg-test",
      actionId: "send",
      data: { inputs: { description: "crash" } },
    });

    await vi.waitFor(() => {
      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ logs: "" }),
        })
      );
    });
  });

  it("allows opening a new dialog after previous one is closed", async () => {
    const { deps, handle } = createMockDeps();
    const module = createBugReportModule(deps);

    await emitKeyEvent(module, "b");
    handle._emitEvent({ dialogId: "dlg-test", actionId: "cancel" });

    // Create a fresh handle for the second dialog
    const handle2 = createMockHandle();
    (deps.dialogManager.open as ReturnType<typeof vi.fn>).mockReturnValue(handle2);

    await emitKeyEvent(module, "b");
    expect(deps.dialogManager.open).toHaveBeenCalledTimes(2);
  });
});
