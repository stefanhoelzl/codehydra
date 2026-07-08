/**
 * Shared test utilities for the MCP server unit and boundary tests.
 *
 * Registers canned mock operations for every MCP tool intent on a dispatcher,
 * capturing dispatched intents for assertions. The delete-workspace operation
 * is the event-emitting variant: workspace_delete waits for a terminal
 * deletion-progress event to learn the real outcome, and `deleteControl` lets
 * tests pick success / blocked / preflight-reject behavior.
 */

import { createServer } from "node:net";
import { vi } from "vitest";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Intent } from "../intents/lib/types";
import type { Operation, OperationContext } from "../intents/lib/operation";
import { type ProjectId, type DeletionProgress } from "../shared/api/types";
import {
  INTENT_GET_WORKSPACE_STATUS,
  GET_WORKSPACE_STATUS_OPERATION_ID,
} from "../intents/get-workspace-status";
import { INTENT_GET_METADATA, GET_METADATA_OPERATION_ID } from "../intents/get-metadata";
import { INTENT_SET_METADATA, SET_METADATA_OPERATION_ID } from "../intents/set-metadata";
import {
  INTENT_GET_AGENT_SESSION,
  GET_AGENT_SESSION_OPERATION_ID,
} from "../intents/get-agent-session";
import { INTENT_RESTART_AGENT, RESTART_AGENT_OPERATION_ID } from "../intents/restart-agent";
import {
  INTENT_RESOLVE_WORKSPACE,
  RESOLVE_WORKSPACE_OPERATION_ID,
} from "../intents/resolve-workspace";
import {
  INTENT_HIBERNATE_WORKSPACE,
  HIBERNATE_WORKSPACE_OPERATION_ID,
} from "../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, WAKE_WORKSPACE_OPERATION_ID } from "../intents/wake-workspace";
import { INTENT_LIST_PROJECTS, LIST_PROJECTS_OPERATION_ID } from "../intents/list-projects";
import { INTENT_OPEN_WORKSPACE, OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import {
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  type DeleteWorkspaceIntent,
} from "../intents/delete-workspace";
import { INTENT_VSCODE_COMMAND, VSCODE_COMMAND_OPERATION_ID } from "../intents/vscode-command";
import {
  INTENT_VSCODE_SHOW_MESSAGE,
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
} from "../intents/vscode-show-message";
import {
  INTENT_SUBMIT_BUG_REPORT,
  SUBMIT_BUG_REPORT_OPERATION_ID,
} from "../intents/submit-bug-report";

/**
 * Find a free port for testing.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get port"));
      }
    });
    server.on("error", reject);
  });
}

/** Controls the mock delete-workspace operation's behavior. */
export interface DeleteControl {
  mode: "success" | "blocked" | "reject";
  blockingProcesses?: ReadonlyArray<{ pid: number; name: string }>;
}

const TOOL_OPERATIONS = {
  getStatus: {
    intent: INTENT_GET_WORKSPACE_STATUS,
    operationId: GET_WORKSPACE_STATUS_OPERATION_ID,
    result: { isDirty: false, unmergedCommits: 0, agent: { type: "none" as const } } as unknown,
  },
  getMetadata: {
    intent: INTENT_GET_METADATA,
    operationId: GET_METADATA_OPERATION_ID,
    result: { base: "main" } as unknown,
  },
  setMetadata: {
    intent: INTENT_SET_METADATA,
    operationId: SET_METADATA_OPERATION_ID,
    result: undefined as unknown,
  },
  getAgentSession: {
    intent: INTENT_GET_AGENT_SESSION,
    operationId: GET_AGENT_SESSION_OPERATION_ID,
    result: { port: 14001, sessionId: "test-session" } as unknown,
  },
  restartAgent: {
    intent: INTENT_RESTART_AGENT,
    operationId: RESTART_AGENT_OPERATION_ID,
    result: 14001 as unknown,
  },
  listProjects: {
    intent: INTENT_LIST_PROJECTS,
    operationId: LIST_PROJECTS_OPERATION_ID,
    result: [] as unknown,
  },
  openWorkspace: {
    intent: INTENT_OPEN_WORKSPACE,
    operationId: OPEN_WORKSPACE_OPERATION_ID,
    result: {
      name: "test",
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    } as unknown,
  },
  executeCommand: {
    intent: INTENT_VSCODE_COMMAND,
    operationId: VSCODE_COMMAND_OPERATION_ID,
    result: undefined as unknown,
  },
  showMessage: {
    intent: INTENT_VSCODE_SHOW_MESSAGE,
    operationId: VSCODE_SHOW_MESSAGE_OPERATION_ID,
    result: null as unknown,
  },
  resolveWorkspace: {
    intent: INTENT_RESOLVE_WORKSPACE,
    operationId: RESOLVE_WORKSPACE_OPERATION_ID,
    result: {
      projectPath: "/home/user/projects/my-app",
      workspaceName: "feature-branch",
      active: false,
    } as unknown,
  },
  hibernate: {
    intent: INTENT_HIBERNATE_WORKSPACE,
    operationId: HIBERNATE_WORKSPACE_OPERATION_ID,
    result: { started: true } as unknown,
  },
  wake: {
    intent: INTENT_WAKE_WORKSPACE,
    operationId: WAKE_WORKSPACE_OPERATION_ID,
    result: {
      name: "test",
      path: "/path",
      branch: "main",
      metadata: { base: "main" },
      projectId: "test-12345678" as ProjectId,
    } as unknown,
  },
  submitBugReport: {
    intent: INTENT_SUBMIT_BUG_REPORT,
    operationId: SUBMIT_BUG_REPORT_OPERATION_ID,
    result: undefined as unknown,
  },
} as const;

type ToolOperationKey = keyof typeof TOOL_OPERATIONS | "deleteWorkspace";

export interface MockToolOperations {
  /** Per-tool execute spies (vi.fn), keyed as in the unit tests. */
  operations: Record<ToolOperationKey, ReturnType<typeof vi.fn>>;
  /** Every intent received by any mock operation, in dispatch order. */
  capturedIntents: Intent[];
  /** Controls the delete-workspace operation's outcome. */
  deleteControl: DeleteControl;
}

/**
 * Register canned mock operations for all MCP tool intents on the dispatcher.
 *
 * @param dispatcher - The dispatcher to register on
 * @param overrides - Per-tool canned result overrides (e.g. `{ getAgentSession: null }`)
 */
export function createMockToolOperations(
  dispatcher: Dispatcher,
  overrides: Partial<Record<keyof typeof TOOL_OPERATIONS, unknown>> = {}
): MockToolOperations {
  const capturedIntents: Intent[] = [];
  const operations = {} as Record<ToolOperationKey, ReturnType<typeof vi.fn>>;

  for (const [key, def] of Object.entries(TOOL_OPERATIONS) as Array<
    [keyof typeof TOOL_OPERATIONS, (typeof TOOL_OPERATIONS)[keyof typeof TOOL_OPERATIONS]]
  >) {
    const result = key in overrides ? overrides[key] : def.result;
    const execute = vi.fn(async (ctx: OperationContext<Intent>): Promise<unknown> => {
      capturedIntents.push(ctx.intent);
      return result;
    });
    const operation: Operation<Intent, unknown> = { id: def.operationId, execute };
    dispatcher.registerOperation(def.intent, operation);
    operations[key] = execute;
  }

  // workspace_delete waits for a terminal deletion-progress event to learn the
  // real outcome, so the mock delete op emits one.
  const deleteControl: DeleteControl = { mode: "success" };
  const deleteExecute = vi.fn(
    async (ctx: OperationContext<DeleteWorkspaceIntent>): Promise<{ started: true }> => {
      capturedIntents.push(ctx.intent);
      if (deleteControl.mode === "reject") {
        throw new Error("Preflight check failed: Workspace has uncommitted changes");
      }
      const { workspacePath, keepBranch } = ctx.intent.payload;
      const hasErrors = deleteControl.mode === "blocked";
      const progress: DeletionProgress = {
        workspacePath: workspacePath as DeletionProgress["workspacePath"],
        workspaceName: "feature-branch" as DeletionProgress["workspaceName"],
        projectId: "test-12345678" as ProjectId,
        keepBranch,
        operations: [
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
            status: hasErrors ? "error" : "done",
            ...(hasErrors ? { error: "EBUSY: resource busy or locked" } : {}),
          },
        ],
        completed: true,
        hasErrors,
        ...(deleteControl.blockingProcesses
          ? {
              blockingProcesses: deleteControl.blockingProcesses.map((p) => ({
                pid: p.pid,
                name: p.name,
                commandLine: p.name,
                files: [],
                cwd: null,
              })),
            }
          : {}),
      };
      await ctx.emit({ type: EVENT_WORKSPACE_DELETION_PROGRESS, payload: progress });
      return { started: true };
    }
  );
  const deleteOperation: Operation<DeleteWorkspaceIntent, { started: true }> = {
    id: DELETE_WORKSPACE_OPERATION_ID,
    execute: deleteExecute,
  };
  dispatcher.registerOperation(INTENT_DELETE_WORKSPACE, deleteOperation);
  operations.deleteWorkspace = deleteExecute;

  return { operations, capturedIntents, deleteControl };
}
