// @vitest-environment node
/**
 * Integration tests for createMcpHandlers.
 *
 * Tests verify each handler dispatches the correct intent type and payload.
 * All operations — including UI and command — go through the dispatcher.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";
import type { Intent } from "../intents/infrastructure/types";
import type { OperationContext, Operation } from "../intents/infrastructure/operation";

import {
  INTENT_GET_WORKSPACE_STATUS,
  GET_WORKSPACE_STATUS_OPERATION_ID,
} from "../operations/get-workspace-status";
import { INTENT_GET_METADATA, GET_METADATA_OPERATION_ID } from "../operations/get-metadata";
import { INTENT_SET_METADATA, SET_METADATA_OPERATION_ID } from "../operations/set-metadata";
import {
  INTENT_GET_AGENT_SESSION,
  GET_AGENT_SESSION_OPERATION_ID,
} from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT, RESTART_AGENT_OPERATION_ID } from "../operations/restart-agent";
import { INTENT_OPEN_WORKSPACE, OPEN_WORKSPACE_OPERATION_ID } from "../operations/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../operations/delete-workspace";
import { INTENT_LIST_PROJECTS, LIST_PROJECTS_OPERATION_ID } from "../operations/list-projects";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
} from "../operations/vscode-show-message";
import { INTENT_VSCODE_COMMAND, VSCODE_COMMAND_OPERATION_ID } from "../operations/vscode-command";
import type { ProjectId, WorkspaceName, Project } from "../../shared/api/types";

import { createMcpHandlers } from "./mcp-handlers";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a test operation that captures the intent and returns a mock result.
 */
function createCapturingOperation<TIntent extends Intent = Intent, TResult = void>(
  operationId: string,
  capturedIntents: Intent[],
  result: TResult
): Operation<TIntent, TResult> {
  return {
    id: operationId,
    async execute(ctx: OperationContext<TIntent>): Promise<TResult> {
      capturedIntents.push(ctx.intent);
      return result;
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

function createTestSetup() {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  const capturedIntents: Intent[] = [];

  dispatcher.registerOperation(
    INTENT_GET_WORKSPACE_STATUS,
    createCapturingOperation(GET_WORKSPACE_STATUS_OPERATION_ID, capturedIntents, {
      isDirty: false,
      unmergedCommits: 0,
      agent: { type: "none" as const },
    })
  );

  dispatcher.registerOperation(
    INTENT_GET_METADATA,
    createCapturingOperation(GET_METADATA_OPERATION_ID, capturedIntents, {
      base: "main",
    } as Readonly<Record<string, string>>)
  );

  dispatcher.registerOperation(
    INTENT_SET_METADATA,
    createCapturingOperation(SET_METADATA_OPERATION_ID, capturedIntents, undefined as void)
  );

  dispatcher.registerOperation(
    INTENT_GET_AGENT_SESSION,
    createCapturingOperation(GET_AGENT_SESSION_OPERATION_ID, capturedIntents, {
      port: 14001,
      sessionId: "test-session",
    })
  );

  dispatcher.registerOperation(
    INTENT_RESTART_AGENT,
    createCapturingOperation(RESTART_AGENT_OPERATION_ID, capturedIntents, 14001)
  );

  dispatcher.registerOperation(
    INTENT_OPEN_WORKSPACE,
    createCapturingOperation(OPEN_WORKSPACE_OPERATION_ID, capturedIntents, {
      projectId: "test-12345678" as ProjectId,
      name: "feature" as WorkspaceName,
      branch: "feature",
      metadata: { base: "main" },
      path: "/workspaces/feature",
    })
  );

  dispatcher.registerOperation(
    INTENT_DELETE_WORKSPACE,
    createCapturingOperation(DELETE_WORKSPACE_OPERATION_ID, capturedIntents, { started: true })
  );

  const mockProjects: Project[] = [
    {
      id: "proj-12345678" as ProjectId,
      name: "my-project",
      path: "/projects/my-project",
      workspaces: [],
    },
  ];

  dispatcher.registerOperation(
    INTENT_LIST_PROJECTS,
    createCapturingOperation(LIST_PROJECTS_OPERATION_ID, capturedIntents, mockProjects)
  );

  dispatcher.registerOperation(
    INTENT_VSCODE_SHOW_MESSAGE,
    createCapturingOperation(
      VSCODE_SHOW_MESSAGE_OPERATION_ID,
      capturedIntents,
      null as string | null
    )
  );

  dispatcher.registerOperation(
    INTENT_VSCODE_COMMAND,
    createCapturingOperation(
      VSCODE_COMMAND_OPERATION_ID,
      capturedIntents,
      "command-result" as unknown
    )
  );

  return { dispatcher, capturedIntents, mockProjects };
}

// =============================================================================
// Tests
// =============================================================================

describe("createMcpHandlers", () => {
  describe("getStatus", () => {
    it("dispatches GetWorkspaceStatusIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.getStatus("/workspace/path");

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_GET_WORKSPACE_STATUS);
      expect(capturedIntents[0]!.payload).toEqual({ workspacePath: "/workspace/path" });
      expect(result).toEqual({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } });
    });
  });

  describe("getMetadata", () => {
    it("dispatches GetMetadataIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.getMetadata("/workspace/path");

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_GET_METADATA);
      expect(capturedIntents[0]!.payload).toEqual({ workspacePath: "/workspace/path" });
      expect(result).toEqual({ base: "main" });
    });
  });

  describe("setMetadata", () => {
    it("dispatches SetMetadataIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.setMetadata("/workspace/path", "note", "test value");

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_SET_METADATA);
      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        key: "note",
        value: "test value",
      });
    });
  });

  describe("getAgentSession", () => {
    it("dispatches GetAgentSessionIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.getAgentSession("/workspace/path");

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_GET_AGENT_SESSION);
      expect(capturedIntents[0]!.payload).toEqual({ workspacePath: "/workspace/path" });
      expect(result).toEqual({ port: 14001, sessionId: "test-session" });
    });
  });

  describe("restartAgentServer", () => {
    it("dispatches RestartAgentIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.restartAgentServer("/workspace/path");

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_RESTART_AGENT);
      expect(capturedIntents[0]!.payload).toEqual({ workspacePath: "/workspace/path" });
      expect(result).toBe(14001);
    });
  });

  describe("listProjects", () => {
    it("dispatches ListProjectsIntent and returns projects", async () => {
      const { dispatcher, capturedIntents, mockProjects } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.listProjects();

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_LIST_PROJECTS);
      expect(result).toEqual(mockProjects);
    });
  });

  describe("createWorkspace", () => {
    it("dispatches OpenWorkspaceIntent with mapped payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.createWorkspace({
        projectPath: "/projects/my-project",
        name: "feature",
        base: "main",
        stealFocus: false,
      });

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_OPEN_WORKSPACE);
      expect(capturedIntents[0]!.payload).toEqual({
        projectPath: "/projects/my-project",
        workspaceName: "feature",
        base: "main",
        stealFocus: false,
      });
      expect(result.name).toBe("feature");
    });

    it("includes initialPrompt when provided", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.createWorkspace({
        projectPath: "/projects/my-project",
        name: "feature",
        base: "main",
        initialPrompt: "Implement the feature",
      });

      expect(capturedIntents[0]!.payload).toMatchObject({
        initialPrompt: "Implement the feature",
      });
    });
  });

  describe("deleteWorkspace", () => {
    it("dispatches DeleteWorkspaceIntent and returns started: true on accept", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.deleteWorkspace("/workspace/path", { keepBranch: false });

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_DELETE_WORKSPACE);
      expect(capturedIntents[0]!.payload).toMatchObject({
        workspacePath: "/workspace/path",
        keepBranch: false,
        force: false,
        removeWorktree: true,
      });
      expect(result).toEqual({ started: true });
    });

    it("passes ignoreWarnings through to intent payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.deleteWorkspace("/workspace/path", {
        keepBranch: false,
        ignoreWarnings: true,
      });

      expect(capturedIntents[0]!.payload).toMatchObject({
        ignoreWarnings: true,
      });
    });

    it("defaults ignoreWarnings to false", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.deleteWorkspace("/workspace/path", { keepBranch: false });

      expect(capturedIntents[0]!.payload).toMatchObject({
        ignoreWarnings: false,
      });
    });

    it("awaits full result and propagates thrown errors", async () => {
      const dispatcher = new Dispatcher({ logger: createMockLogger() });

      // Register an operation that throws (simulates preflight failure)
      dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, {
        id: DELETE_WORKSPACE_OPERATION_ID,
        async execute(): Promise<{ started: true }> {
          throw new Error("Preflight check failed: Workspace has uncommitted changes");
        },
      });

      const handlers = createMcpHandlers(dispatcher);

      await expect(
        handlers.deleteWorkspace("/workspace/path", { keepBranch: false })
      ).rejects.toThrow("Preflight check failed: Workspace has uncommitted changes");
    });

    it("returns started: false when interceptor rejects", async () => {
      const dispatcher = new Dispatcher({ logger: createMockLogger() });

      dispatcher.registerOperation(
        INTENT_DELETE_WORKSPACE,
        createCapturingOperation(DELETE_WORKSPACE_OPERATION_ID, [], { started: true })
      );

      // Add interceptor that cancels delete
      dispatcher.addInterceptor({
        id: "block-delete",
        async before(intent) {
          if (intent.type === INTENT_DELETE_WORKSPACE) return null;
          return intent;
        },
      });

      const handlers = createMcpHandlers(dispatcher);
      const result = await handlers.deleteWorkspace("/workspace/path", { keepBranch: true });

      expect(result).toEqual({ started: false });
    });
  });

  describe("executeCommand", () => {
    it("dispatches VscodeCommandIntent with correct payload", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      const result = await handlers.executeCommand("/workspace/path", "test.command", ["arg1"]);

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_VSCODE_COMMAND);
      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        command: "test.command",
        args: ["arg1"],
      });
      expect(result).toBe("command-result");
    });
  });

  describe("showMessage", () => {
    it("dispatches VscodeShowMessageIntent for notification", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.showMessage("/workspace/path", {
        type: "info",
        message: "Hello",
      });

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]!.type).toBe(INTENT_VSCODE_SHOW_MESSAGE);
      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        type: "info",
        message: "Hello",
      });
    });

    it("dispatches VscodeShowMessageIntent for status bar", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.showMessage("/workspace/path", {
        type: "status",
        message: "Building...",
        hint: "Running build task",
      });

      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        type: "status",
        message: "Building...",
        hint: "Running build task",
      });
    });

    it("dispatches VscodeShowMessageIntent for status bar dismiss", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.showMessage("/workspace/path", {
        type: "status",
        message: null,
      });

      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        type: "status",
        message: null,
      });
    });

    it("dispatches VscodeShowMessageIntent for select with options", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.showMessage("/workspace/path", {
        type: "select",
        message: "Choose a file",
        options: ["a.ts", "b.ts"],
        hint: "Filter...",
      });

      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        type: "select",
        message: "Choose a file",
        options: ["a.ts", "b.ts"],
        hint: "Filter...",
      });
    });

    it("dispatches VscodeShowMessageIntent for free text input", async () => {
      const { dispatcher, capturedIntents } = createTestSetup();
      const handlers = createMcpHandlers(dispatcher);

      await handlers.showMessage("/workspace/path", {
        type: "select",
        message: "Enter your name",
        hint: "Name",
      });

      expect(capturedIntents[0]!.payload).toEqual({
        workspacePath: "/workspace/path",
        type: "select",
        message: "Enter your name",
        hint: "Name",
      });
    });
  });
});
