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

import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./get-agent-session";
import type {
  GetAgentSessionIntent,
  GetAgentSessionHookInput,
  GetAgentSessionHookResult,
} from "./get-agent-session";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult } from "./resolve-workspace";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { WorkspaceName, AgentSession } from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import { extractWorkspaceName } from "../../shared/api/id-utils";

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
  workspaceName: WorkspaceName;
}

function createTestSetup(opts: { agentStatusManager?: MockAgentStatusManager | null }): TestSetup {
  const workspaceName = extractWorkspaceName(WORKSPACE_PATH) as WorkspaceName;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());

  // Resolve module: validates workspacePath → returns projectPath + workspaceName
  const resolveModule: IntentModule = {
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as { payload: { workspacePath: string } };
            if (intent.payload.workspacePath === WORKSPACE_PATH) {
              return { projectPath: PROJECT_ROOT, workspaceName };
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

  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(agentSessionModule);

  return { dispatcher, workspaceName };
}

// =============================================================================
// Helpers
// =============================================================================

function sessionIntent(workspacePath: string): GetAgentSessionIntent {
  return {
    type: INTENT_GET_AGENT_SESSION,
    payload: { workspacePath },
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
      const { dispatcher } = setup;

      const result = (await dispatcher.dispatch(
        sessionIntent(WORKSPACE_PATH)
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

      const result = await setup.dispatcher.dispatch(sessionIntent(WORKSPACE_PATH));

      expect(result).toBeNull();
    });

    it("returns null when no agent status manager", async () => {
      const setup = createTestSetup({
        agentStatusManager: null,
      });

      const result = await setup.dispatcher.dispatch(sessionIntent(WORKSPACE_PATH));

      expect(result).toBeNull();
    });
  });

  describe("error cases", () => {
    it("unknown workspace path throws", async () => {
      const setup = createTestSetup({ agentStatusManager: null });

      await expect(setup.dispatcher.dispatch(sessionIntent("/nonexistent/path"))).rejects.toThrow(
        "Workspace not found: /nonexistent/path"
      );
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

      const result = await setup.dispatcher.dispatch(sessionIntent(WORKSPACE_PATH));

      expect(result).toBeUndefined();
    });
  });
});
