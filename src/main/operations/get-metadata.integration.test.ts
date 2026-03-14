// @vitest-environment node
/**
 * Integration tests for get-metadata operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> provider,
 * using behavioral mocks for git client and API registry.
 *
 * Test plan items covered:
 * #11: Get metadata returns record
 * #16: Hook data flows to operation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./set-metadata";
import type { SetMetadataIntent, SetHookInput } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataIntent, GetMetadataHookResult, GetHookInput } from "./get-metadata";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type {
  ResolveHookInput as ResolveProjectHookInput,
  ResolveHookResult as ResolveProjectHookResult,
} from "./resolve-project";
import { createIpcEventBridge } from "../modules/ipc-event-bridge";
import type { IpcEventBridgeDeps } from "../modules/ipc-event-bridge";
import { createMockGitClient } from "../../services/git/git-client.state-mock";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { SILENT_LOGGER } from "../../services/logging";
import { createBehavioralIpcLayer } from "../../services/platform/ipc.test-utils";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Intent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = new Path("/project");
const WORKSPACES_DIR = new Path("/workspaces");

// =============================================================================
// Test Setup Helper
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
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

  // Register workspace so metadata operations can resolve projectRoot
  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  gitWorktreeProvider.ensureWorkspaceRegistered(workspacePath, PROJECT_ROOT);

  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = extractWorkspaceName(workspacePath.toString()) as WorkspaceName;

  // Build dispatcher with hook registry
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());

  // resolve module: validates workspacePath → returns projectPath + workspaceName
  const resolveModule: IntentModule = {
    name: "test",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const intent = ctx.intent as { payload: { workspacePath: string } };
            if (intent.payload.workspacePath === workspacePath.toString()) {
              return { projectPath: PROJECT_ROOT.toString(), workspaceName };
            }
            return {};
          },
        },
      },
    },
  };

  // resolve-project module: resolves projectPath → projectId
  const resolveProjectModule: IntentModule = {
    name: "test",
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

  // set/get module: performs actual provider operations (reads workspacePath from enriched context)
  const metadataModule: IntentModule = {
    name: "test",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath: wp } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
            await gitWorktreeProvider.setMetadata(
              new Path(wp),
              intent.payload.key,
              intent.payload.value
            );
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
            const { workspacePath: wp } = ctx as GetHookInput;
            const metadata = await gitWorktreeProvider.getMetadata(new Path(wp));
            return { metadata };
          },
        },
      },
    },
  };

  // Wire IpcEventBridge
  const ipcEventBridge = createIpcEventBridge({
    ipcLayer: createBehavioralIpcLayer(),
    sendToUI: vi.fn(),
    logger: SILENT_LOGGER,
    dispatcher: dispatcher as unknown as IpcEventBridgeDeps["dispatcher"],
    agentStatusManager: {
      getStatus: vi.fn(),
    } as unknown as IpcEventBridgeDeps["agentStatusManager"],
  });
  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(resolveProjectModule);
  dispatcher.registerModule(metadataModule);
  dispatcher.registerModule(ipcEventBridge);

  return {
    dispatcher,
    projectId,
    workspaceName,
    workspacePath: workspacePath.toString(),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function setMetadataIntent(
  workspacePath: string,
  key: string,
  value: string | null
): SetMetadataIntent {
  return {
    type: INTENT_SET_METADATA,
    payload: { workspacePath, key, value },
  };
}

function getMetadataIntent(workspacePath: string): GetMetadataIntent {
  return {
    type: INTENT_GET_METADATA,
    payload: { workspacePath },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetMetadata Operation", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  it("returns metadata record from provider (#11)", async () => {
    const { dispatcher, workspacePath } = setup;

    // First set some metadata
    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Then get metadata
    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // Should contain our custom key; no base since none was set in config
    expect(result).toBeDefined();
    expect(result.base).toBeUndefined();
    expect(result.description).toBe("my workspace");
  });

  it("returns empty metadata without custom keys (#11)", async () => {
    const { dispatcher, workspacePath } = setup;

    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // No config set, so metadata is empty
    expect(result).toBeDefined();
    expect(result.base).toBeUndefined();
  });

  it("hook data flows from hook to operation via extended context (#16)", async () => {
    const { dispatcher, workspacePath } = setup;

    // The get metadata hook returns { metadata } (GetMetadataHookResult)
    // The operation merges results from all handlers
    const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

    // If hook data flow is broken, operation throws "Get metadata hook did not provide metadata result"
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  describe("interceptor", () => {
    it("cancels get metadata intent", async () => {
      const { dispatcher, workspacePath } = setup;

      dispatcher.addInterceptor({
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      });

      const result = await dispatcher.dispatch(getMetadataIntent(workspacePath));

      expect(result).toBeUndefined();
    });
  });
});
