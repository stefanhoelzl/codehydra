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
import { wireModules } from "../intents/infrastructure/wire";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
  EVENT_METADATA_CHANGED,
} from "./set-metadata";
import type { SetMetadataIntent, MetadataChangedEvent } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataIntent, GetMetadataHookResult } from "./get-metadata";
import { createIpcEventBridge } from "../modules/ipc-event-bridge";
import { createMockGitClient } from "../../services/git/git-client.state-mock";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { SILENT_LOGGER } from "../../services/logging";
import { Path } from "../../services/platform/path";
import { resolveWorkspace } from "../api/id-utils";
import type { WorkspaceAccessor } from "../api/id-utils";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";
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

  // Build workspace accessor (simulates AppState)
  const projectId = generateProjectId(PROJECT_ROOT.toString());
  const workspaceName = extractWorkspaceName(workspacePath.toString()) as WorkspaceName;

  const workspaceAccessor: WorkspaceAccessor = {
    getAllProjects: async () => [{ path: PROJECT_ROOT.toString() }],
    getProject: (projectPath: string) => {
      if (new Path(projectPath).equals(PROJECT_ROOT)) {
        return {
          path: PROJECT_ROOT.toString(),
          name: "project",
          workspaces: [
            {
              path: workspacePath.toString(),
              branch: "feature-x",
              metadata: { base: "main" },
            },
          ],
        };
      }
      return undefined;
    },
  };

  // Build dispatcher with hook registry
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());

  // Register provider hook handlers (same pattern as bootstrap.ts)
  hookRegistry.register(SET_METADATA_OPERATION_ID, "set", {
    handler: async (ctx: HookContext) => {
      const intent = ctx.intent as SetMetadataIntent;
      const { workspace } = await resolveWorkspace(intent.payload, workspaceAccessor);
      await globalProvider.setMetadata(
        new Path(workspace.path),
        intent.payload.key,
        intent.payload.value
      );
    },
  });

  hookRegistry.register(GET_METADATA_OPERATION_ID, "get", {
    handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
      const intent = ctx.intent as GetMetadataIntent;
      const { workspace } = await resolveWorkspace(intent.payload, workspaceAccessor);
      const metadata = await globalProvider.getMetadata(new Path(workspace.path));
      return { metadata };
    },
  });

  // Wire IpcEventBridge
  const mockApiRegistry = createMockApiRegistry();
  const ipcEventBridge = createIpcEventBridge(
    mockApiRegistry as unknown as import("../api/registry-types").IApiRegistry
  );
  wireModules([ipcEventBridge], hookRegistry, dispatcher);

  return {
    dispatcher,
    mockClient,
    mockApiRegistry,
    projectId,
    workspaceName,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function setMetadataIntent(
  projectId: ProjectId,
  workspaceName: WorkspaceName,
  key: string,
  value: string | null
): SetMetadataIntent {
  return {
    type: INTENT_SET_METADATA,
    payload: { projectId, workspaceName, key, value },
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
    const { dispatcher, mockClient, projectId, workspaceName } = setup;

    await dispatcher.dispatch(
      setMetadataIntent(projectId, workspaceName, "description", "my workspace")
    );

    // Verify git config was written
    expect(mockClient).toHaveBranchConfig(
      PROJECT_ROOT,
      "feature-x",
      "codehydra.description",
      "my workspace"
    );
  });

  it("emits workspace:metadata-changed domain event to IpcEventBridge (#10)", async () => {
    const { dispatcher, mockApiRegistry, projectId, workspaceName } = setup;

    await dispatcher.dispatch(
      setMetadataIntent(projectId, workspaceName, "description", "my workspace")
    );

    // Verify ApiRegistry.emit was called via IpcEventBridge
    expect(mockApiRegistry.emit).toHaveBeenCalledWith("workspace:metadata-changed", {
      projectId,
      workspaceName,
      key: "description",
      value: "my workspace",
    });
  });

  it("emits domain event with null value for deletion", async () => {
    const { dispatcher, mockApiRegistry, projectId, workspaceName } = setup;

    await dispatcher.dispatch(setMetadataIntent(projectId, workspaceName, "description", null));

    expect(mockApiRegistry.emit).toHaveBeenCalledWith("workspace:metadata-changed", {
      projectId,
      workspaceName,
      key: "description",
      value: null,
    });
  });

  it("domain event subscriber receives event directly (#10)", async () => {
    const { dispatcher, projectId, workspaceName } = setup;

    const receivedEvents: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_METADATA_CHANGED, (event) => {
      receivedEvents.push(event);
    });

    await dispatcher.dispatch(setMetadataIntent(projectId, workspaceName, "description", "test"));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0] as MetadataChangedEvent;
    expect(event.type).toBe(EVENT_METADATA_CHANGED);
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.key).toBe("description");
    expect(event.payload.value).toBe("test");
  });

  describe("error cases", () => {
    it("invalid metadata key throws (#12)", async () => {
      const { dispatcher, projectId, workspaceName } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(projectId, workspaceName, "invalid key!", "value"))
      ).rejects.toThrow("Invalid metadata key");
    });

    it("unknown workspace throws (#13)", async () => {
      const { dispatcher, projectId } = setup;

      await expect(
        dispatcher.dispatch(
          setMetadataIntent(projectId, "nonexistent" as WorkspaceName, "key", "value")
        )
      ).rejects.toThrow("Workspace not found");
    });

    it("unknown project throws (#13)", async () => {
      const { dispatcher, workspaceName } = setup;

      await expect(
        dispatcher.dispatch(
          setMetadataIntent("nonexistent-12345678" as ProjectId, workspaceName, "key", "value")
        )
      ).rejects.toThrow("Project not found");
    });

    it("no event emitted on error", async () => {
      const { dispatcher, mockApiRegistry, projectId, workspaceName } = setup;

      await expect(
        dispatcher.dispatch(setMetadataIntent(projectId, workspaceName, "invalid key!", "value"))
      ).rejects.toThrow();

      expect(mockApiRegistry.emit).not.toHaveBeenCalled();
    });
  });

  describe("interceptor", () => {
    it("cancels metadata intent - no state change, no event (#15)", async () => {
      const { dispatcher, mockClient, mockApiRegistry, projectId, workspaceName } = setup;

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
        setMetadataIntent(projectId, workspaceName, "description", "my workspace")
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
