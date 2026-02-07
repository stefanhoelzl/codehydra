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
import { wireModules } from "../intents/infrastructure/wire";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./set-metadata";
import type { SetMetadataIntent } from "./set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./get-metadata";
import type { GetMetadataIntent, GetMetadataHookContext } from "./get-metadata";
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
import type { Intent } from "../intents/infrastructure/types";
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
    handler: async (ctx: HookContext) => {
      const intent = ctx.intent as GetMetadataIntent;
      const { workspace } = await resolveWorkspace(intent.payload, workspaceAccessor);
      const metadata = await globalProvider.getMetadata(new Path(workspace.path));
      (ctx as GetMetadataHookContext).metadata = metadata;
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

function getMetadataIntent(projectId: ProjectId, workspaceName: WorkspaceName): GetMetadataIntent {
  return {
    type: INTENT_GET_METADATA,
    payload: { projectId, workspaceName },
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
    const { dispatcher, projectId, workspaceName } = setup;

    // First set some metadata
    await dispatcher.dispatch(
      setMetadataIntent(projectId, workspaceName, "description", "my workspace")
    );

    // Then get metadata
    const result = await dispatcher.dispatch(getMetadataIntent(projectId, workspaceName));

    // Should contain both the base key (fallback to branch name) and our custom key
    expect(result).toBeDefined();
    expect(result.base).toBe("feature-x"); // Fallback: no codehydra.base in config, so uses branch name
    expect(result.description).toBe("my workspace");
  });

  it("returns base metadata even without custom keys (#11)", async () => {
    const { dispatcher, projectId, workspaceName } = setup;

    const result = await dispatcher.dispatch(getMetadataIntent(projectId, workspaceName));

    // Should have base key from fallback
    expect(result).toBeDefined();
    expect(result.base).toBe("feature-x");
  });

  it("hook data flows from hook to operation via extended context (#16)", async () => {
    const { dispatcher, projectId, workspaceName } = setup;

    // The get metadata hook stores result in ctx.metadata (GetMetadataHookContext)
    // The operation reads it back after hook execution
    const result = await dispatcher.dispatch(getMetadataIntent(projectId, workspaceName));

    // If hook data flow is broken, operation throws "Get metadata hook did not provide metadata result"
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  describe("interceptor", () => {
    it("cancels get metadata intent", async () => {
      const { dispatcher, projectId, workspaceName } = setup;

      dispatcher.addInterceptor({
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      });

      const result = await dispatcher.dispatch(getMetadataIntent(projectId, workspaceName));

      expect(result).toBeUndefined();
    });
  });
});
