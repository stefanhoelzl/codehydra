// @vitest-environment node
/**
 * Integration tests for MetadataModule through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> provider,
 * using real GitWorktreeProvider with behavioral mocks for git client and filesystem.
 *
 * The module under test is createMetadataModule (the extracted hook handler).
 * Resolve-project and resolve-workspace are inline stubs.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { SetMetadataOperation, INTENT_SET_METADATA } from "../intents/set-metadata";
import type { SetMetadataIntent } from "../intents/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "../intents/get-metadata";
import type { GetMetadataIntent } from "../intents/get-metadata";
import { registerTestInfrastructure } from "../intents/operations.test-utils";
import { createMetadataModule } from "./metadata-module";
import { createMockGitClient } from "../boundaries/platform/git-client.state-mock";
import { createFileSystemMock, directory } from "../boundaries/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = new Path("/project");
const WORKSPACES_DIR = new Path("/workspaces");

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  mockClient: ReturnType<typeof createMockGitClient>;
  projectId: ProjectId;
  workspaceName: WorkspaceName;
  workspacePath: string;
}

function createTestSetup(): TestSetup {
  const mockClient = createMockGitClient({
    repositories: {
      [PROJECT_ROOT.toString()]: {
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [
          {
            name: "feature-x",
            path: new Path(WORKSPACES_DIR, "feature-x").toString(),
            branch: "feature-x",
          },
        ],
      },
    },
  });

  const mockFs = createFileSystemMock({
    entries: {
      [WORKSPACES_DIR.toString()]: directory(),
    },
  });

  const gitWorktreeProvider = new GitWorktreeProvider(mockClient, mockFs, SILENT_LOGGER);
  gitWorktreeProvider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);

  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  gitWorktreeProvider.ensureWorkspaceRegistered(workspacePath, PROJECT_ROOT);

  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = "feature-x" as WorkspaceName;

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new SetMetadataOperation());
  dispatcher.registerOperation(new GetMetadataOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [workspacePath.toString()]: { projectPath: PROJECT_ROOT.toString(), workspaceName },
    },
    projects: { [PROJECT_ROOT.toString()]: { projectId } },
  });

  // Module under test
  const metadataModule = createMetadataModule({ gitWorktreeProvider });
  dispatcher.registerModule(metadataModule);

  return {
    dispatcher,
    mockClient,
    projectId,
    workspaceName,
    workspacePath: workspacePath.toString(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MetadataModule Integration", () => {
  it("set then get returns correct metadata (round-trip)", async () => {
    const { dispatcher, workspacePath } = createTestSetup();

    const setIntent: SetMetadataIntent = {
      type: INTENT_SET_METADATA,
      payload: { workspacePath, key: "description", value: "my workspace" },
    };
    await dispatcher.dispatch(setIntent);

    const getIntent: GetMetadataIntent = {
      type: INTENT_GET_METADATA,
      payload: { workspacePath },
    };
    const metadata = await dispatcher.dispatch(getIntent);

    expect(metadata).toMatchObject({ description: "my workspace" });
  });

  it("set with null value deletes key", async () => {
    const { dispatcher, workspacePath } = createTestSetup();

    // Set a value first
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { workspacePath, key: "description", value: "to be deleted" },
    } satisfies SetMetadataIntent);

    // Delete it
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { workspacePath, key: "description", value: null },
    } satisfies SetMetadataIntent);

    // Get should not contain the deleted key
    const metadata = await dispatcher.dispatch({
      type: INTENT_GET_METADATA,
      payload: { workspacePath },
    } satisfies GetMetadataIntent);

    expect(metadata).not.toHaveProperty("description");
  });
});
