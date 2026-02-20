// @vitest-environment node
/**
 * Integration tests for restart-agent operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> result,
 * including event emission on success and error propagation on failure.
 *
 * Test plan items covered:
 * #5: restart-agent returns new port on success
 * #6: restart-agent throws on failure with error message
 * #7: restart-agent emits agent:restarted event on success
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentInterceptor } from "../intents/infrastructure/dispatcher";

import {
  RestartAgentOperation,
  RESTART_AGENT_OPERATION_ID,
  INTENT_RESTART_AGENT,
  EVENT_AGENT_RESTARTED,
} from "./restart-agent";
import type {
  RestartAgentIntent,
  RestartAgentHookInput,
  RestartAgentHookResult,
  ResolveHookResult,
  ResolveProjectHookResult,
  ResolveProjectHookInput,
  AgentRestartedEvent,
} from "./restart-agent";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { DomainEvent, Intent } from "../intents/infrastructure/types";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import { generateProjectId, extractWorkspaceName } from "../../shared/api/id-utils";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = "/project";
const WORKSPACE_PATH = "/workspaces/feature-x";

// =============================================================================
// Behavioral Mocks
// =============================================================================

type RestartServerResult =
  | { readonly success: true; readonly port: number }
  | { readonly success: false; readonly error: string; readonly serverStopped: boolean };

interface MockAgentServerManager {
  restartResult: RestartServerResult;
  restartServer(workspacePath: string): Promise<RestartServerResult>;
}

function createMockAgentServerManager(result: RestartServerResult): MockAgentServerManager {
  return {
    restartResult: result,
    restartServer: async () => result,
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

function createTestSetup(opts: { serverManager: MockAgentServerManager }): TestSetup {
  const projectId = generateProjectId(PROJECT_ROOT);
  const workspaceName = extractWorkspaceName(WORKSPACE_PATH) as WorkspaceName;

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_RESTART_AGENT, new RestartAgentOperation());

  // Resolve module: validates workspacePath → returns projectPath + workspaceName
  const resolveModule: IntentModule = {
    hooks: {
      [RESTART_AGENT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as RestartAgentIntent;
            if (intent.payload.workspacePath === WORKSPACE_PATH) {
              return { projectPath: PROJECT_ROOT, workspaceName };
            }
            return {};
          },
        },
      },
    },
  };

  // Resolve-project module: resolves projectPath → projectId (for domain events)
  const resolveProjectModule: IntentModule = {
    hooks: {
      [RESTART_AGENT_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
            const { projectPath } = ctx as ResolveProjectHookInput;
            if (projectPath === PROJECT_ROOT) {
              return { projectId };
            }
            return {};
          },
        },
      },
    },
  };

  // Restart hook handler module (reads from enriched context)
  const restartModule: IntentModule = {
    hooks: {
      [RESTART_AGENT_OPERATION_ID]: {
        restart: {
          handler: async (ctx: HookContext): Promise<RestartAgentHookResult> => {
            const { workspacePath } = ctx as RestartAgentHookInput;
            const result = await opts.serverManager.restartServer(workspacePath);
            if (result.success) {
              return { port: result.port };
            } else {
              throw new Error(result.error);
            }
          },
        },
      },
    },
  };

  dispatcher.registerModule(resolveModule);
  dispatcher.registerModule(resolveProjectModule);
  dispatcher.registerModule(restartModule);

  return { dispatcher, projectId, workspaceName };
}

// =============================================================================
// Helpers
// =============================================================================

function restartIntent(workspacePath: string): RestartAgentIntent {
  return {
    type: INTENT_RESTART_AGENT,
    payload: { workspacePath },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("RestartAgent Operation", () => {
  describe("returns new port on success (#5)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({
        serverManager: createMockAgentServerManager({
          success: true,
          port: 9090,
        }),
      });
    });

    it("returns port number from restart", async () => {
      const { dispatcher } = setup;

      const result = await dispatcher.dispatch(restartIntent(WORKSPACE_PATH));

      expect(result).toBe(9090);
    });
  });

  describe("throws on failure (#6)", () => {
    it("throws with error message from server manager", async () => {
      const setup = createTestSetup({
        serverManager: createMockAgentServerManager({
          success: false,
          error: "Server process exited unexpectedly",
          serverStopped: true,
        }),
      });

      await expect(setup.dispatcher.dispatch(restartIntent(WORKSPACE_PATH))).rejects.toThrow(
        "Server process exited unexpectedly"
      );
    });
  });

  describe("emits agent:restarted event (#7)", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup({
        serverManager: createMockAgentServerManager({
          success: true,
          port: 9090,
        }),
      });
    });

    it("emits event with port and workspace path", async () => {
      const { dispatcher, projectId, workspaceName } = setup;

      const receivedEvents: DomainEvent[] = [];
      dispatcher.subscribe(EVENT_AGENT_RESTARTED, (event) => {
        receivedEvents.push(event);
      });

      await dispatcher.dispatch(restartIntent(WORKSPACE_PATH));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0] as AgentRestartedEvent;
      expect(event.type).toBe(EVENT_AGENT_RESTARTED);
      expect(event.payload.projectId).toBe(projectId);
      expect(event.payload.workspaceName).toBe(workspaceName);
      expect(event.payload.path).toBe(WORKSPACE_PATH);
      expect(event.payload.port).toBe(9090);
    });

    it("does not emit event on failure", async () => {
      const failSetup = createTestSetup({
        serverManager: createMockAgentServerManager({
          success: false,
          error: "Failed",
          serverStopped: true,
        }),
      });

      const receivedEvents: DomainEvent[] = [];
      failSetup.dispatcher.subscribe(EVENT_AGENT_RESTARTED, (event) => {
        receivedEvents.push(event);
      });

      await expect(failSetup.dispatcher.dispatch(restartIntent(WORKSPACE_PATH))).rejects.toThrow();

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("error cases", () => {
    it("unknown workspace path throws", async () => {
      const setup = createTestSetup({
        serverManager: createMockAgentServerManager({ success: true, port: 9090 }),
      });

      await expect(setup.dispatcher.dispatch(restartIntent("/nonexistent/path"))).rejects.toThrow(
        "Workspace not found: /nonexistent/path"
      );
    });
  });

  describe("interceptor", () => {
    it("cancellation prevents operation execution (#14)", async () => {
      const setup = createTestSetup({
        serverManager: createMockAgentServerManager({ success: true, port: 9090 }),
      });

      const receivedEvents: DomainEvent[] = [];
      setup.dispatcher.subscribe(EVENT_AGENT_RESTARTED, (event) => {
        receivedEvents.push(event);
      });

      const cancelInterceptor: IntentInterceptor = {
        id: "cancel-all",
        async before(): Promise<Intent | null> {
          return null;
        },
      };
      setup.dispatcher.addInterceptor(cancelInterceptor);

      const result = await setup.dispatcher.dispatch(restartIntent(WORKSPACE_PATH));

      expect(result).toBeUndefined();
      expect(receivedEvents).toHaveLength(0);
    });
  });
});
