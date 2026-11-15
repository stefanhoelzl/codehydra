// @vitest-environment node
/**
 * Integration tests for the cli.install-global setting: flipping it installs
 * or uninstalls right away, a failure flips it back and says why, and an
 * enabled setting is repaired quietly at every start.
 */

import { describe, it, expect } from "vitest";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import type { HookContext } from "../../intents/lib/operation";
import type { NotificationConfig } from "../../shared/notification-types";
import { createCliGlobalModule, INSTALL_GLOBAL_KEY } from "./module";
import type { InstallOptions, InstallResult } from "./installer";

function setup(options: { enabled?: boolean; allowed?: boolean; fail?: boolean } = {}) {
  const calls: Array<{ action: "install" | "uninstall"; interactive: boolean }> = [];
  const notifications: NotificationConfig[] = [];
  const config = createMockConfig({ defaults: { [INSTALL_GLOBAL_KEY]: options.enabled ?? false } });
  const handle = createCliGlobalModule({
    config,
    installer: {
      install: async ({ interactive }: InstallOptions): Promise<InstallResult> => {
        calls.push({ action: "install", interactive });
        if (options.fail) throw new Error("no way");
        return { location: "/home/me/.local/bin/ch" };
      },
      uninstall: async ({ interactive }: InstallOptions): Promise<void> => {
        calls.push({ action: "uninstall", interactive });
        if (options.fail) throw new Error("no way");
      },
    },
    allowed: options.allowed ?? true,
    dispatcher: {
      dispatch: ((intent: { payload: { config: NotificationConfig } }) => {
        notifications.push(intent.payload.config);
        return Promise.resolve({ id: "n" });
      }) as never,
    },
    logger: SILENT_LOGGER,
  });
  return { handle, calls, notifications };
}

describe("CliGlobalModule", () => {
  it("installs when the setting is turned on", async () => {
    const { handle, calls, notifications } = setup();

    await handle.installGlobal.set(true);
    await handle.idle();

    expect(calls).toEqual([{ action: "install", interactive: true }]);
    expect(notifications[0]?.type).toBe("info");
  });

  it("uninstalls when the setting is turned off", async () => {
    const { handle, calls } = setup({ enabled: true });

    await handle.installGlobal.set(false);
    await handle.idle();

    expect(calls).toEqual([{ action: "uninstall", interactive: true }]);
  });

  it("turns the setting back and says why when the install fails", async () => {
    const { handle, calls, notifications } = setup({ fail: true });

    await handle.installGlobal.set(true);
    await handle.idle();

    expect(handle.installGlobal.get()).toBe(false);
    // The revert itself does not try to uninstall.
    expect(calls).toEqual([{ action: "install", interactive: true }]);
    expect(notifications[0]).toMatchObject({ type: "error", message: "no way" });
  });

  it("installs nothing for a build that must not, and says so", async () => {
    const { handle, calls, notifications } = setup({ allowed: false });

    await handle.installGlobal.set(true);
    await handle.idle();

    expect(calls).toEqual([]);
    expect(notifications[0]?.type).toBe("warning");
  });

  it("repairs an enabled setting at start, without prompting", async () => {
    const { handle, calls, notifications } = setup({ enabled: true });

    await start(handle);

    expect(calls).toEqual([{ action: "install", interactive: false }]);
    expect(notifications).toEqual([]);
  });

  it("says so when the repair at start fails, and keeps the setting on", async () => {
    const { handle, calls, notifications } = setup({ enabled: true, fail: true });

    await start(handle);

    expect(calls).toEqual([{ action: "install", interactive: false }]);
    expect(handle.installGlobal.get()).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "warning" });
    expect(notifications[0]?.message).toContain("no way");
  });

  it("leaves everything alone at start when the setting is off", async () => {
    const { handle, calls } = setup({ enabled: false });

    await start(handle);

    expect(calls).toEqual([]);
  });
});

async function start(handle: ReturnType<typeof setup>["handle"]): Promise<void> {
  await handle.module.hooks![APP_START_OPERATION_ID]!["start"]!.handler({} as HookContext);
  await handle.idle();
}
