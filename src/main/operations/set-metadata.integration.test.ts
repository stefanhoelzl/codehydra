// @vitest-environment node
/**
 * Integration tests for set-metadata operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> provider,
 * using behavioral mocks for git client and API registry.
 *
 * Test plan items covered:
 * #9:  Set metadata writes to git config
 * #10: Set metadata emits domain event
 * #12: Invalid metadata key throws
 * #13: Unknown workspace throws
 * #15: Interceptor cancels metadata intent (no state change, no event)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";

import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
  EVENT_METADATA_CHANGED,
} from "./set-metadata";
import type { SetMetadataIntent, MetadataChangedEvent, SetHookInput } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataHookResult, GetHookInput } from "./get-metadata";
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
import { createMockGitClient } from "../../services/git/git-client.state-mock";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
import type { HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = new Path("/project");
const WORKSPACES_DIR = new Path("/workspaces");

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
// Test Setup Helper
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  mockClient: ReturnType<typeof createMockGitClient>;
  mockApiRegistry: MockApiRegistry;
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

  // Register workspace so metadata operations can resolve projectRoot
  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  globalProvider.ensureWorkspaceRegistered(workspacePath, PROJECT_ROOT);

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
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath: wp } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
            await globalProvider.setMetadata(
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
            const metadata = await globalProvider.getMetadata(new Path(wp));
            return { metadata };
          },
        },
      },
    },
  };

  // Wire IpcEventBridge
  const mockApiRegistry = createMockApiRegistry();
  const ipcEventBridge = createIpcEventBridge({
    apiRegistry: mockApiRegistry as unknown as import("../api/registry-types").IApiRegistry,
    getApi: () => {
      throw new Error("not wired");
    },
    sendToUI: vi.fn(),
    pluginServer: null,
    logger: SILENT_LOGGER,
    dispatcher:
      dispatcher as unknown as import("../modules/ipc-event-bridge").IpcEventBridgeDeps["dispatcher"],
    agentStatusManager: {
      getStatus: vi.fn(),
    } as unknown as import("../modules/ipc-event-bridge").IpcEventBridgeDeps["agentStatusManager"],
    globalWorktreeProvider: {
      listWorktrees: vi.fn(),
    } as unknown as import("../modules/ipc-event-bridge").IpcEventBridgeDeps["globalWorktreeProvider"],
    deleteOp: {
      hasPendingRetry: vi.fn().mockReturnValue(false),
      signalDismiss: vi.fn(),
      signalRetry: vi.fn(),
    } as unknown as import("../modules/ipc-event-bridge").IpcEventBridgeDeps["deleteOp"],
  });
  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(resolveProjectModule);
  dispatcher.registerModule(metadataModule);
  dispatcher.registerModule(ipcEventBridge);

  return {
    dispatcher,
    mockClient,
    mockApiRegistry,
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

// =============================================================================
// Tests
// =============================================================================

describe("SetMetadata Operation", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  it("writes to git config via provider (#9)", async () => {
    const { dispatcher, mockClient, workspacePath } = setup;

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Verify git config was written
    expect(mockClient).toHaveBranchConfig(
      PROJECT_ROOT,
      "feature-x",
      "codehydra.description",
      "my workspace"
    );
  });

  it("emits workspace:metadata-changed domain event to IpcEventBridge (#10)", async () => {
    const { dispatcher, mockApiRegistry, projectId, workspaceName, workspacePath } = setup;

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "my workspace"));

    // Verify ApiRegistry.emit was called via IpcEventBridge
    expect(mockApiRegistry.emit).toHaveBeenCalledWith("workspace:metadata-changed", {
      projectId,
      workspaceName,
      key: "description",
      value: "my workspace",
    });
  });

  it("emits domain event with null value for deletion", async () => {
    const { dispatcher, mockApiRegistry, projectId, workspaceName, workspacePath } = setup;

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", null));

    expect(mockApiRegistry.emit).toHaveBeenCalledWith("workspace:metadata-changed", {
      projectId,
      workspaceName,
      key: "description",
      value: null,
    });
  });

  it("domain event subscriber receives event directly (#10)", async () => {
    const { dispatcher, projectId, workspacePath } = setup;

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(setMetadataIntent(workspacePath, "description", "test"));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as MetadataChangedEvent;
    expect(event.type).toBe(EVENT_METADATA_CHANGED);
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.key).toBe("description");
    expect(event.payload.value).toBe("test");
  });

  describe("error cases", () => {
    it("invalid metadata key throws (#12)", async () => {
      const { dispatcher, workspacePath } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(workspacePath, "invalid key!", "value"))
      ).rejects.toThrow("Invalid metadata key");
    });

    it("unknown workspace path throws (#13)", async () => {
      const { dispatcher } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent("/nonexistent/path", "key", "value"))
      ).rejects.toThrow("Workspace not found: /nonexistent/path");
    });

    it("no event emitted on error", async () => {
      const { dispatcher, mockApiRegistry, workspacePath } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(workspacePath, "invalid key!", "value"))
      ).rejects.toThrow();

      expect(mockApiRegistry.emit).not.toHaveBeenCalled();
    });
  });

  describe("interceptor", () => {
    it("cancels metadata intent - no state change, no event (#15)", async () => {
      const { dispatcher, mockClient, mockApiRegistry, workspacePath } = setup;

      // Add cancel interceptor
      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      dispatcher.addInterceptor(cancelInterceptor);

      // Dispatch should return undefined (cancelled)
      const result = await dispatcher.dispatch(
        setMetadataIntent(workspacePath, "description", "my workspace")
      );

      expect(result).toBeUndefined();

      // No git config written
      const repo = mockClient.$.repositories.get(PROJECT_ROOT.toString());
      const configs = repo?.branchConfigs.get("feature-x");
      expect(configs?.get("codehydra.description")).toBeUndefined();

      // No event emitted
      expect(mockApiRegistry.emit).not.toHaveBeenCalled();
    });
  });
});
