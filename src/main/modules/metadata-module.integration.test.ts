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

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { SetMetadataOperation, INTENT_SET_METADATA } from "../operations/set-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "../operations/get-metadata";
import type { GetMetadataIntent } from "../operations/get-metadata";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "../operations/resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "../operations/resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "../operations/resolve-project";
import type {
  ResolveHookResult as ResolveProjectHookResult,
  ResolveHookInput as ResolveProjectHookInput,
} from "../operations/resolve-project";
import { createMetadataModule } from "./metadata-module";
import { createMockGitClient } from "../../services/git/git-client.state-mock";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";

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

  const globalProvider = new GitWorktreeProvider(mockClient, mockFs, SILENT_LOGGER);
  globalProvider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);

  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  globalProvider.ensureWorkspaceRegistered(workspacePath, PROJECT_ROOT);

  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = extractWorkspaceName(workspacePath.toString()) as WorkspaceName;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  // resolve stub: validates workspacePath → returns projectPath + workspaceName
  const resolveModule: IntentModule = {
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { workspacePath: wsPath } = ctx as { workspacePath: string } & HookContext;
            if (wsPath === workspacePath.toString()) {
              return { projectPath: PROJECT_ROOT.toString(), workspaceName };
            }
            return {};
          },
        },
      },
    },
  };

  // resolve-project stub: resolves projectPath → projectId (for set-metadata commands)
  const resolveProjectModule: IntentModule = {
    hooks: {
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as ResolveProjectHookInput;
            if (projectPath === PROJECT_ROOT.toString()) {
              return { projectId };
            }
            return {};
          },
        },
      },
    },
  };

  // Module under test
  const metadataModule = createMetadataModule({ globalProvider });

  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(resolveProjectModule);
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
