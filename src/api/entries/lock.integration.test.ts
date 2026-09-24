// @vitest-environment node
/**
 * The `lock.*` registry entries, run through the real registry against the real
 * lock module — so scope resolution, validation, workspace enforcement and the
 * shape of each answer are asserted as a caller sees them.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const SNAPSYNC = projPath("/projects/snapsync");
const CODEHYDRA = projPath("/projects/codehydra");
const IOS = wsPath("/projects/snapsync/workspaces/ios");
const ANDROID = wsPath("/projects/snapsync/workspaces/android");
const CH_LOCK = wsPath("/projects/codehydra/workspaces/ch-lock");

function setup() {
  const dispatcher = createMockDispatcher();
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: workspacePath.startsWith(SNAPSYNC) ? SNAPSYNC : CODEHYDRA,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
    }),
    projects: {
      [SNAPSYNC]: { projectId: "snapsync-1" as ProjectId },
      [CODEHYDRA]: { projectId: "codehydra-1" as ProjectId },
    },
  });
  const locks = createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks;
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
    },
    SILENT_LOGGER
  );

  /** Call an operation as a caller standing in `workspace`, on its own connection. */
  const call = (
    name: OperationName,
    workspace: WorkspacePath | null,
    input: Record<string, unknown> = {},
    signal: AbortSignal = new AbortController().signal
  ): Promise<unknown> => {
    const ctx: OperationContext = {
      workspacePath: workspace,
      callerWorkspacePath: workspace,
      cwd: null,
      signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, locks };
}

describe("lock entries", () => {
  describe("lock.take", () => {
    it("takes a lock for the caller's workspace", async () => {
      const { call, locks } = setup();

      await expect(call("lock.take", IOS, { name: "device", reason: "smoke" })).resolves.toEqual({
        name: "device",
        scope: "global",
        acquired: true,
        waitedSeconds: 0,
      });
      expect(locks.list()[0]).toMatchObject({ holder: IOS, project: null, reason: "smoke" });
    });

    it("needs a workspace to hold it", async () => {
      const { call } = setup();

      await expect(call("lock.take", null, { name: "device" })).rejects.toMatchObject({
        category: "no-workspace",
      });
    });

    it("rejects a name outside letters, digits, hyphens and underscores", async () => {
      const { call } = setup();

      await expect(call("lock.take", IOS, { name: "the/phone" })).rejects.toMatchObject({
        category: "usage",
        message: expect.stringContaining("lock names are letters, digits, hyphens and underscores"),
      });
    });

    it("fails with conflict under --no-wait", async () => {
      const { call } = setup();
      await call("lock.take", IOS, { name: "device" });

      await expect(
        call("lock.take", ANDROID, { name: "device", noWait: true })
      ).rejects.toMatchObject({ category: "conflict" });
    });

    it("scopes a project lock to the caller's project", async () => {
      const { call } = setup();
      await call("lock.take", IOS, { name: "fixtures", scope: "project" });

      // Another project's workspace gets its own `fixtures`…
      await expect(
        call("lock.take", CH_LOCK, { name: "fixtures", scope: "project", noWait: true })
      ).resolves.toMatchObject({ acquired: true });
      // …while a sibling in the same project contends for it.
      await expect(
        call("lock.take", ANDROID, { name: "fixtures", scope: "project", noWait: true })
      ).rejects.toMatchObject({ category: "conflict" });
    });
  });

  describe("lock.hold", () => {
    it("is released when the caller's connection closes", async () => {
      const { call, locks } = setup();
      const connection = new AbortController();
      await call("lock.hold", IOS, { name: "device" }, connection.signal);

      connection.abort();

      expect(locks.list()).toEqual([]);
    });
  });

  describe("lock.release", () => {
    it("releases a named lock", async () => {
      const { call, locks } = setup();
      await call("lock.take", IOS, { name: "device" });

      await expect(call("lock.release", IOS, { name: "device" })).resolves.toEqual({
        released: ["device"],
      });
      expect(locks.list()).toEqual([]);
    });

    it("is not-found for a lock the caller does not hold", async () => {
      const { call } = setup();
      await call("lock.take", IOS, { name: "device" });

      await expect(call("lock.release", ANDROID, { name: "device" })).rejects.toMatchObject({
        category: "not-found",
      });
    });

    it("releases everything the caller holds, and only that, when no name is given", async () => {
      const { call, locks } = setup();
      await call("lock.take", IOS, { name: "device" });
      await call("lock.take", IOS, { name: "fixtures", scope: "project" });
      await call("lock.take", ANDROID, { name: "gpu" });

      const result = (await call("lock.release", IOS)) as { released: string[] };

      expect([...result.released].sort()).toEqual(["device", "fixtures"]);
      expect(locks.list().map((l) => l.name)).toEqual(["gpu"]);
    });

    it("limits a nameless release to the scope given", async () => {
      const { call, locks } = setup();
      await call("lock.take", IOS, { name: "device" });
      await call("lock.take", IOS, { name: "fixtures", scope: "project" });

      await expect(call("lock.release", IOS, { scope: "project" })).resolves.toEqual({
        released: ["fixtures"],
      });
      expect(locks.list().map((l) => l.name)).toEqual(["device"]);
    });

    it("releases nothing, successfully, when the caller holds nothing and names nothing", async () => {
      const { call } = setup();

      await expect(call("lock.release", IOS)).resolves.toEqual({ released: [] });
    });
  });

  describe("lock.list", () => {
    it("lists both namespaces as table rows, from anywhere", async () => {
      const { call } = setup();
      await call("lock.take", IOS, { name: "device", reason: "pull crash logs" });
      void call("lock.take", ANDROID, { name: "device" });
      void call("lock.take", CH_LOCK, { name: "device" });
      await call("lock.take", ANDROID, { name: "fixtures", scope: "project" });

      await expect(call("lock.list", null)).resolves.toEqual([
        {
          name: "device",
          project: "",
          holder: "ios",
          held: "0s",
          reason: "pull crash logs",
          waiting: "android, ch-lock",
        },
        {
          name: "fixtures",
          project: "snapsync",
          holder: "android",
          held: "0s",
          reason: "",
          waiting: "",
        },
      ]);
    });

    it("filters to one namespace with --scope", async () => {
      const { call } = setup();
      await call("lock.take", IOS, { name: "device" });
      await call("lock.take", ANDROID, { name: "fixtures", scope: "project" });
      await call("lock.take", CH_LOCK, { name: "fixtures", scope: "project" });

      const global = (await call("lock.list", null, { scope: "global" })) as { name: string }[];
      const project = (await call("lock.list", ANDROID, { scope: "project" })) as {
        name: string;
        project: string;
      }[];

      expect(global.map((l) => l.name)).toEqual(["device"]);
      // Only the caller's project, not codehydra's `fixtures`.
      expect(project.map((l) => [l.name, l.project])).toEqual([["fixtures", "snapsync"]]);
    });

    it("needs a workspace to know which project --scope project means", async () => {
      const { call } = setup();

      await expect(call("lock.list", null, { scope: "project" })).rejects.toMatchObject({
        category: "no-workspace",
      });
    });
  });
});
