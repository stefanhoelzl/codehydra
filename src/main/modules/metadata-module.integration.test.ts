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
import { wireModules } from "../intents/infrastructure/wire";
import { SetMetadataOperation, INTENT_SET_METADATA } from "../operations/set-metadata";
import type {
  SetMetadataIntent,
  ResolveProjectHookResult as SetResolveProjectHookResult,
  ResolveWorkspaceHookResult as SetResolveWorkspaceHookResult,
  ResolveWorkspaceHookInput as SetResolveWorkspaceHookInput,
} from "../operations/set-metadata";
import { SET_METADATA_OPERATION_ID } from "../operations/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "../operations/get-metadata";
import type {
  GetMetadataIntent,
  ResolveProjectHookResult as GetResolveProjectHookResult,
  ResolveWorkspaceHookResult as GetResolveWorkspaceHookResult,
  ResolveWorkspaceHookInput as GetResolveWorkspaceHookInput,
} from "../operations/get-metadata";
import { GET_METADATA_OPERATION_ID } from "../operations/get-metadata";
import { createMetadataModule } from "./metadata-module";
import { createMockGitClient } from "../../services/git/git-client.state-mock";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";
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

  const projectId = generateProjectId(PROJECT_ROOT.toString());
  const workspaceName = extractWorkspaceName(workspacePath.toString()) as WorkspaceName;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());

  // resolve-project stub
  const resolveProjectModule: IntentModule = {
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SetResolveProjectHookResult> => {
            const intent = ctx.intent as SetMetadataIntent;
            if (intent.payload.projectId === projectId) {
              return { projectPath: PROJECT_ROOT.toString() };
            }
            return {};
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<GetResolveProjectHookResult> => {
            const intent = ctx.intent as GetMetadataIntent;
            if (intent.payload.projectId === projectId) {
              return { projectPath: PROJECT_ROOT.toString() };
            }
            return {};
          },
        },
      },
    },
  };

  // resolve-workspace stub
  const resolveWorkspaceModule: IntentModule = {
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<SetResolveWorkspaceHookResult> => {
            const { workspaceName: name } = ctx as SetResolveWorkspaceHookInput;
            if (name === workspaceName) {
              return { workspacePath: workspacePath.toString() };
            }
            return {};
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<GetResolveWorkspaceHookResult> => {
            const { workspaceName: name } = ctx as GetResolveWorkspaceHookInput;
            if (name === workspaceName) {
              return { workspacePath: workspacePath.toString() };
            }
            return {};
          },
        },
      },
    },
  };

  // Module under test
  const metadataModule = createMetadataModule({ globalProvider });

  wireModules(
    [resolveProjectModule, resolveWorkspaceModule, metadataModule],
    hookRegistry,
    dispatcher
  );

  return { dispatcher, mockClient, projectId, workspaceName };
}

// =============================================================================
// Tests
// =============================================================================

describe("MetadataModule Integration", () => {
  it("set then get returns correct metadata (round-trip)", async () => {
    const { dispatcher, projectId, workspaceName } = createTestSetup();

    const setIntent: SetMetadataIntent = {
      type: INTENT_SET_METADATA,
      payload: { projectId, workspaceName, key: "description", value: "my workspace" },
    };
    await dispatcher.dispatch(setIntent);

    const getIntent: GetMetadataIntent = {
      type: INTENT_GET_METADATA,
      payload: { projectId, workspaceName },
    };
    const metadata = await dispatcher.dispatch(getIntent);

    expect(metadata).toMatchObject({ description: "my workspace" });
  });

  it("set with null value deletes key", async () => {
    const { dispatcher, projectId, workspaceName } = createTestSetup();

    // Set a value first
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { projectId, workspaceName, key: "description", value: "to be deleted" },
    } satisfies SetMetadataIntent);

    // Delete it
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { projectId, workspaceName, key: "description", value: null },
    } satisfies SetMetadataIntent);

    // Get should not contain the deleted key
    const metadata = await dispatcher.dispatch({
      type: INTENT_GET_METADATA,
      payload: { projectId, workspaceName },
    } satisfies GetMetadataIntent);

    expect(metadata).not.toHaveProperty("description");
  });
});
