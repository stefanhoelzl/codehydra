// @vitest-environment node
/**
 * Integration tests for get-agent-session operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * using a behavioral mock for AgentStatusManager.
 *
 * Test plan items covered:
 * #3: get-agent-session returns session info
 * #4: get-agent-session returns null when no session
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./get-agent-session";
import type { GetAgentSessionIntent, GetAgentSessionHookResult } from "./get-agent-session";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { resolveWorkspace } from "../api/id-utils";
import type { WorkspaceAccessor } from "../api/id-utils";
import type { ProjectId, WorkspaceName, AgentSession } from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = "/project";
const WORKSPACE_PATH = "/workspaces/feature-x";

// =============================================================================
// Behavioral Mocks
// =============================================================================

interface AgentSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}

interface MockAgentStatusManager {
  sessionMap: Map<string, AgentSessionInfo | null>;
  getSession(path: WorkspacePath): AgentSessionInfo | null;
}

function createMockAgentStatusManager(
  entries: Record<string, AgentSessionInfo | null> = {}
): MockAgentStatusManager {
  const sessionMap = new Map(Object.entries(entries));
  return {
    sessionMap,
    getSession: (path: WorkspacePath) => sessionMap.get(path) ?? null,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  projectId: ProjectId;
  workspaceName: WorkspaceName;
}

function createTestSetup(opts: { agentStatusManager?: MockAgentStatusManager | null }): TestSetup {
  const projectId = generateProjectId(PROJECT_ROOT);
  const workspaceName = extractWorkspaceName(WORKSPACE_PATH) as WorkspaceName;

  const workspaceAccessor: WorkspaceAccessor = {
    getAllProjects: async () => [{ path: PROJECT_ROOT }],
    getProject: (projectPath: string) => {
      if (new Path(projectPath).equals(new Path(PROJECT_ROOT))) {
        return {
          path: PROJECT_ROOT,
          name: "project",
          workspaces: [
            {
              path: WORKSPACE_PATH,
              branch: "feature-x",
              metadata: { base: "main" },
            },
          ],
        };
      }
      return undefined;
    },
  };

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());

  // Agent session hook handler module
  const agentSessionModule: IntentModule = {
    hooks: {
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult> => {
            const intent = ctx.intent as GetAgentSessionIntent;
            const { workspace } = await resolveWorkspace(intent.payload, workspaceAccessor);
            const manager = opts.agentStatusManager;
            const session = manager?.getSession(workspace.path as WorkspacePath) ?? null;
            return { session };
          },
        },
      },
    },
  };

  wireModules([agentSessionModule], hookRegistry, dispatcher);

  return { dispatcher, projectId, workspaceName };
}

// =============================================================================
// Helpers
// =============================================================================

function sessionIntent(projectId: ProjectId, workspaceName: WorkspaceName): GetAgentSessionIntent {
  return {
    type: INTENT_GET_AGENT_SESSION,
    payload: { projectId, workspaceName },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("GetAgentSession Operation", () => {
  describe("returns session info (#3)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({
        agentStatusManager: createMockAgentStatusManager({
          [WORKSPACE_PATH]: { port: 8080, sessionId: "ses-001" },
        }),
      });
    });

    it("returns session with port and sessionId", async () => {
      const { dispatcher, projectId, workspaceName } = setup;

      const result = (await dispatcher.dispatch(
        sessionIntent(projectId, workspaceName)
      )) as AgentSession | null;

      expect(result).toEqual({ port: 8080, sessionId: "ses-001" });
    });
  });

  describe("returns null when no session (#4)", () => {
    it("returns null when no session exists for workspace", async () => {
      const setup = createTestSetup({
        agentStatusManager: createMockAgentStatusManager({
          // No entry for workspace
        }),
      });

      const result = await setup.dispatcher.dispatch(
        sessionIntent(setup.projectId, setup.workspaceName)
      );

      expect(result).toBeNull();
    });

    it("returns null when no agent status manager", async () => {
      const setup = createTestSetup({
        agentStatusManager: null,
      });

      const result = await setup.dispatcher.dispatch(
        sessionIntent(setup.projectId, setup.workspaceName)
      );

      expect(result).toBeNull();
    });
  });

  describe("error cases", () => {
    it("unknown workspace throws", async () => {
      const setup = createTestSetup({ agentStatusManager: null });

      await expect(
        setup.dispatcher.dispatch(sessionIntent(setup.projectId, "nonexistent" as WorkspaceName))
      ).rejects.toThrow("Workspace not found");
    });

    it("unknown project throws", async () => {
      const setup = createTestSetup({ agentStatusManager: null });

      await expect(
        setup.dispatcher.dispatch(
          sessionIntent("nonexistent-12345678" as ProjectId, setup.workspaceName)
        )
      ).rejects.toThrow("Project not found");
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        agentStatusManager: createMockAgentStatusManager({
          [WORKSPACE_PATH]: { port: 8080, sessionId: "ses-001" },
        }),
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(
        sessionIntent(setup.projectId, setup.workspaceName)
      );

      expect(result).toBeUndefined();
    });
  });
});
