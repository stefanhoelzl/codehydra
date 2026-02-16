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
import type {
  GetAgentSessionIntent,
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
  ResolveProjectHookResult,
  ResolveWorkspaceHookInput,
  ResolveWorkspaceHookResult,
} from "./get-agent-session";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { ProjectId, WorkspaceName, AgentSession } from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";

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

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());

  // Resolve-project module: look up projectId
  const resolveProjectModule: IntentModule = {
    hooks: {
      [GET_AGENT_SESSION_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const intent = ctx.intent as GetAgentSessionIntent;
            if (intent.payload.projectId === projectId) {
              return { projectPath: PROJECT_ROOT };
            }
            return {};
          },
        },
      },
    },
  };

  // Resolve-workspace module: look up workspaceName
  const resolveWorkspaceModule: IntentModule = {
    hooks: {
      [GET_AGENT_SESSION_OPERATION_ID]: {
        "resolve-workspace": {
          handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
            const { workspaceName: name } = ctx as ResolveWorkspaceHookInput;
            if (name === workspaceName) {
              return { workspacePath: WORKSPACE_PATH };
            }
            return {};
          },
        },
      },
    },
  };

  // Agent session hook handler module (reads from enriched context)
  const agentSessionModule: IntentModule = {
    hooks: {
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (ctx: HookContext): Promise<GetAgentSessionHookResult> => {
            const { workspacePath } = ctx as GetAgentSessionHookInput;
            const manager = opts.agentStatusManager;
            const session = manager?.getSession(workspacePath as WorkspacePath) ?? null;
            return { session };
          },
        },
      },
    },
  };

  wireModules(
    [resolveProjectModule, resolveWorkspaceModule, agentSessionModule],
    hookRegistry,
    dispatcher
  );

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
