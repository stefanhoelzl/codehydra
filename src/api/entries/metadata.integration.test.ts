// @vitest-environment node
/**
 * The `metadata.*` registry entries as an outside caller (MCP, `ch`, plugins)
 * sees them: run through the real registry, the real metadata operations and
 * the metadata module over a real core workspace registry on an in-memory filesystem.
 * The point is the key tiers — internal keys are hidden, and only public keys
 * can be written.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import { SetMetadataOperation } from "../../intents/set-metadata";
import { GetMetadataOperation } from "../../intents/get-metadata";
import { createMetadataModule } from "../../modules/metadata-module";
import { createLockModule } from "../../modules/lock-module";
import {
  createTestWorkspaceRegistry,
  holdTestWorkspace,
} from "../../modules/workspace-registry.test-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { projPath, testPath, workspaceRefIn } from "../../shared/test-fixtures";
import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const PROJECT_ROOT = testPath("/project");
const FEATURE = testPath("/workspaces/feature-x");

async function setup() {
  const { registry: workspaces } = createTestWorkspaceRegistry();
  await holdTestWorkspace(workspaces, PROJECT_ROOT, FEATURE, { name: "feature-x" });

  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new SetMetadataOperation());
  dispatcher.registerOperation(new GetMetadataOperation());
  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [FEATURE.toString()]: {
        projectPath: projPath(PROJECT_ROOT.toString()),
        workspaceName: "feature-x" as WorkspaceName,
      },
    },
    projects: { [PROJECT_ROOT.toString()]: { projectId: "project-1" as ProjectId } },
  });
  dispatcher.registerModule(createMetadataModule({ registry: workspaces }));

  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      processes: { list: async () => null },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );

  const call = (name: OperationName, input: Record<string, unknown>): Promise<unknown> => {
    const ctx: OperationContext = {
      workspaceRef: workspaceRefIn(projPath(PROJECT_ROOT.toString()), "feature-x"),
      cwd: null,
      signal: new AbortController().signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, workspaces };
}

describe("metadata entries", () => {
  it("shows protected keys and hides internal ones", async () => {
    const { call, workspaces } = await setup();
    await workspaces.setMetadata(FEATURE, "hibernated", "true");
    await workspaces.setMetadata(FEATURE, "agent.pending-prompt", "{}");
    await workspaces.setMetadata(FEATURE, "title", "Login flow");

    expect(await call("metadata.get", {})).toEqual({
      hibernated: "true",
      name: "feature-x",
      title: "Login flow",
    });
  });

  it("writes a public key", async () => {
    const { call, workspaces } = await setup();

    await call("metadata.set", { key: "note", value: "WIP" });

    expect(workspaces.metadata(FEATURE)).toEqual({ name: "feature-x", note: "WIP" });
  });

  it.each([
    "hibernated",
    "hibernated-at",
    "agent",
    "base",
    "name",
    "source",
    "agent.pending-prompt",
  ])("refuses to write %s, a key CodeHydra manages", async (key) => {
    const { call, workspaces } = await setup();

    await expect(call("metadata.set", { key, value: "x" })).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.category === "usage"
    );
    await expect(call("metadata.set", { key, value: null })).rejects.toThrow(ApiError);
    expect(workspaces.metadata(FEATURE)).toEqual({ name: "feature-x" });
  });
});
