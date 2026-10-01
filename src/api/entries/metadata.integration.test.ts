// @vitest-environment node
/**
 * The `metadata.*` registry entries as an outside caller (MCP, `ch`, plugins)
 * sees them: run through the real registry, the real metadata operations and
 * the metadata module over a real GitWorktreeProvider with behavioral mocks.
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
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import { createFileSystemMock } from "../../boundaries/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../boundaries/platform/git-worktree-provider";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { projPath, testPath } from "../../shared/test-fixtures";
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import { Path } from "../../utils/path/path";
import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const PROJECT_ROOT = testPath("/project");
const WORKSPACES_DIR = testPath("/workspaces");
const FEATURE = new Path(WORKSPACES_DIR, "feature-x");

async function setup() {
  const fs = createFileSystemMock();
  const gitClient = createMockGitClient({
    fileSystem: fs,
    repositories: {
      [PROJECT_ROOT.toString()]: {
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: FEATURE.toString(), branch: "feature-x" }],
      },
    },
  });
  const provider = new GitWorktreeProvider(gitClient, fs, SILENT_LOGGER);
  provider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);
  await provider.discover(PROJECT_ROOT);

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
  dispatcher.registerModule(createMetadataModule({ gitWorktreeProvider: provider }));

  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );

  const call = (name: OperationName, input: Record<string, unknown>): Promise<unknown> => {
    const ctx: OperationContext = {
      workspaceRef: makeWorkspaceRef(projectRefFor(projPath(PROJECT_ROOT.toString())), "feature-x"),
      cwd: null,
      signal: new AbortController().signal,
    };
    return registry.invoke(registry.get(name), ctx, input);
  };

  return { call, provider };
}

describe("metadata entries", () => {
  it("shows protected keys and hides internal ones", async () => {
    const { call, provider } = await setup();
    await provider.setMetadata(FEATURE, "hibernated", "true");
    await provider.setMetadata(FEATURE, "agent.pending-prompt", "{}");
    await provider.setMetadata(FEATURE, "title", "Login flow");

    expect(await call("metadata.get", {})).toEqual({
      hibernated: "true",
      name: "feature-x",
      title: "Login flow",
    });
  });

  it("writes a public key", async () => {
    const { call, provider } = await setup();

    await call("metadata.set", { key: "note", value: "WIP" });

    expect(await provider.getMetadata(FEATURE)).toEqual({ name: "feature-x", note: "WIP" });
  });

  it.each(["hibernated", "agent", "base", "name", "source", "agent.pending-prompt"])(
    "refuses to write %s, a key CodeHydra manages",
    async (key) => {
      const { call, provider } = await setup();

      await expect(call("metadata.set", { key, value: "x" })).rejects.toSatisfy(
        (error: unknown) => error instanceof ApiError && error.category === "usage"
      );
      await expect(call("metadata.set", { key, value: null })).rejects.toThrow(ApiError);
      expect(await provider.getMetadata(FEATURE)).toEqual({ name: "feature-x" });
    }
  );
});
