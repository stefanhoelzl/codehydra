// @vitest-environment node
/**
 * Integration tests for get-agent-session operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result.
 *
 * Test plan items covered:
 * #3: get-agent-session returns session info
 * #4: get-agent-session returns null when no session
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "./lib/dispatcher";
import type { IntentInterceptor } from "./lib/dispatcher";

import {
  GetAgentSessionOperation,
  GET_AGENT_SESSION_OPERATION_ID,
  INTENT_GET_AGENT_SESSION,
} from "./get-agent-session";
import type { GetAgentSessionIntent, GetAgentSessionHookResult } from "./get-agent-session";
import { registerTestInfrastructure } from "./operations.test-utils";
import type { IntentModule } from "./lib/module";
import type { Intent } from "./lib/types";
import type { WorkspaceName, AgentSession } from "../shared/api/types";

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

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  workspaceName: WorkspaceName;
}

function createTestSetup(opts: { session?: AgentSessionInfo | null }): TestSetup {
  const workspaceName = "feature-x" as WorkspaceName;

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(INTENT_GET_AGENT_SESSION, new GetAgentSessionOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: { [WORKSPACE_PATH]: { projectPath: PROJECT_ROOT, workspaceName } },
  });

  // Agent session hook handler module (returns session from test data)
  const agentSessionModule: IntentModule = {
    name: "test",
    hooks: {
      [GET_AGENT_SESSION_OPERATION_ID]: {
        get: {
          handler: async (): Promise<GetAgentSessionHookResult> => {
            return { session: opts.session ?? null };
          },
        },
      },
    },
  };

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
        session: { port: 8080, sessionId: "ses-001" },
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
        session: null,
      });

      const result = await setup.dispatcher.dispatch(sessionIntent(WORKSPACE_PATH));

      expect(result).toBeNull();
    });

    it("returns null when no agent status manager", async () => {
      const setup = createTestSetup({
        session: null,
      });

      const result = await setup.dispatcher.dispatch(sessionIntent(WORKSPACE_PATH));

      expect(result).toBeNull();
    });
  });

  describe("error cases", () => {
    it("unknown workspace path throws", async () => {
      const setup = createTestSetup({ session: null });

      await expect(setup.dispatcher.dispatch(sessionIntent("/nonexistent/path"))).rejects.toThrow(
        "Workspace not found: /nonexistent/path"
      );
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        session: { port: 8080, sessionId: "ses-001" },
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
