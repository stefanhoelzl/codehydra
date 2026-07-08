// @vitest-environment node
/**
 * Integration tests for the WorkspaceHookOperation skeleton through the Dispatcher.
 *
 * The six concrete subclasses (get-agent-session, get-metadata, restart-agent,
 * set-metadata, vscode-command, vscode-show-message) are thin specs; the shared
 * behavior lives here:
 * - workspace:resolve failure short-circuits before the hook runs
 * - project:resolve is dispatched only when resolveProject is set
 * - lone hook error is rethrown raw; multiple errors aggregate under errorLabel
 * - extract() receives results in handler order (last-write-wins via lastDefined)
 * - onSuccess event is emitted with resolved identity and the extracted result
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "./dispatcher.test-utils";
import { WorkspaceHookOperation } from "./workspace-operation";
import { lastDefined, requireResult } from "./hook-helpers";
import type { Intent, DomainEvent } from "./types";
import type { HookHandler, HookOutput, OperationSchemas } from "./operation";
import { ResolveWorkspaceOperation, RESOLVE_WORKSPACE_OPERATION_ID } from "../resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "../resolve-workspace";
import { ResolveProjectOperation, RESOLVE_PROJECT_OPERATION_ID } from "../resolve-project";
import type { ResolveHookResult as ResolveProjectHookResult } from "../resolve-project";
import type { IntentModule } from "./module";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Test operation
// =============================================================================

const PROJECT_ROOT = "/project";
const PROJECT_ID = "proj-1" as ProjectId;
const WORKSPACE_PATH = "/workspaces/feature-x";
const WORKSPACE_NAME = "feature-x" as WorkspaceName;

const INTENT_TEST = "test:workspace-hook" as const;
const TEST_OPERATION_ID = "test-workspace-hook";
const EVENT_TEST_DONE = "test:done" as const;

interface TestIntent extends Intent<string> {
  readonly type: typeof INTENT_TEST;
  readonly payload: { readonly workspacePath: string };
}

interface TestHookResult {
  readonly value?: string;
}

const testSchemas = {
  type: INTENT_TEST,
  payload: z.object({ workspacePath: z.string() }).readonly(),
  result: z.string(),
} satisfies OperationSchemas;

class TestOperation extends WorkspaceHookOperation<typeof testSchemas, TestHookResult> {
  readonly schemas = testSchemas;

  constructor(opts?: { resolveProject?: boolean; emitEvent?: boolean }) {
    super(TEST_OPERATION_ID, {
      hookPoint: "work",
      ...(opts?.resolveProject !== undefined && { resolveProject: opts.resolveProject }),
      errorLabel: "test-workspace-hook work hooks failed",
      extract: (results) =>
        requireResult(
          lastDefined(results, (r) => r.value),
          "Test hook did not provide value result"
        ),
      ...(opts?.emitEvent && {
        onSuccess: ({ intent, resolved, project, result }) => ({
          type: EVENT_TEST_DONE,
          payload: {
            projectId: project?.projectId,
            workspaceName: resolved.workspaceName,
            workspacePath: intent.payload.workspacePath,
            result,
          },
        }),
      }),
    });
  }
}

// =============================================================================
// Setup
// =============================================================================

function createSetup(opts: {
  operation: TestOperation;
  workHandlers: readonly HookHandler[];
  registerProject?: boolean;
}): { dispatcher: ReturnType<typeof createMockDispatcher>; hookRuns: () => number } {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(opts.operation);
  dispatcher.registerOperation(new ResolveWorkspaceOperation());
  if (opts.registerProject) {
    dispatcher.registerOperation(new ResolveProjectOperation());
  }

  const resolveModule: IntentModule = {
    name: "test-resolve",
    hooks: {
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx): Promise<HookOutput<ResolveWorkspaceHookResult>> => {
            const intent = ctx.intent as TestIntent;
            if (intent.payload.workspacePath === WORKSPACE_PATH) {
              return { result: { projectPath: PROJECT_ROOT, workspaceName: WORKSPACE_NAME } };
            }
            return { result: {} };
          },
        },
      },
      ...(opts.registerProject && {
        [RESOLVE_PROJECT_OPERATION_ID]: {
          resolve: {
            handler: async (): Promise<HookOutput<ResolveProjectHookResult>> => ({
              result: {
                projectId: PROJECT_ID,
                projectName: "project",
              },
            }),
          },
        },
      }),
    },
  };
  dispatcher.registerModule(resolveModule);

  // One module per work handler (HookDeclarations allows one handler per hook point).
  let runs = 0;
  opts.workHandlers.forEach((h, i) => {
    dispatcher.registerModule({
      name: `test-work-${i}`,
      hooks: {
        [TEST_OPERATION_ID]: {
          work: {
            ...h,
            // Non-async so a streaming (async-generator) handler is forwarded as-is
            // rather than wrapped in a Promise.
            handler: (ctx) => {
              runs++;
              return h.handler(ctx);
            },
          },
        },
      },
    });
  });

  return { dispatcher, hookRuns: () => runs };
}

function testIntent(workspacePath: string = WORKSPACE_PATH): TestIntent {
  return { type: INTENT_TEST, payload: { workspacePath } };
}

// =============================================================================
// Tests
// =============================================================================

describe("WorkspaceHookOperation", () => {
  it("resolve failure short-circuits before the hook runs", async () => {
    const { dispatcher, hookRuns } = createSetup({
      operation: new TestOperation(),
      workHandlers: [{ handler: async () => ({ result: { value: "x" } }) }],
    });

    await expect(dispatcher.dispatch(testIntent("/unknown"))).rejects.toThrow(
      "Workspace not found: /unknown"
    );
    expect(hookRuns()).toBe(0);
  });

  it("returns the extracted result on success", async () => {
    const { dispatcher } = createSetup({
      operation: new TestOperation(),
      workHandlers: [{ handler: async () => ({ result: { value: "result-1" } }) }],
    });

    await expect(dispatcher.dispatch(testIntent())).resolves.toBe("result-1");
  });

  it("rethrows a lone hook error raw", async () => {
    const { dispatcher } = createSetup({
      operation: new TestOperation(),
      workHandlers: [
        {
          handler: async () => {
            throw new Error("provider exploded");
          },
        },
      ],
    });

    await expect(dispatcher.dispatch(testIntent())).rejects.toThrow("provider exploded");
  });

  it("aggregates multiple hook errors under the errorLabel", async () => {
    const { dispatcher } = createSetup({
      operation: new TestOperation(),
      workHandlers: [
        {
          handler: async () => {
            throw new Error("first");
          },
        },
        {
          handler: async () => {
            throw new Error("second");
          },
        },
      ],
    });

    await expect(dispatcher.dispatch(testIntent())).rejects.toThrow(
      "test-workspace-hook work hooks failed"
    );
  });

  it("throws the extract guard when no handler provides a result", async () => {
    const { dispatcher } = createSetup({
      operation: new TestOperation(),
      workHandlers: [{ handler: async () => ({ result: {} }) }],
    });

    await expect(dispatcher.dispatch(testIntent())).rejects.toThrow(
      "Test hook did not provide value result"
    );
  });

  it("emits the onSuccess event with resolved identity, project, and result", async () => {
    const { dispatcher } = createSetup({
      operation: new TestOperation({ resolveProject: true, emitEvent: true }),
      workHandlers: [{ handler: async () => ({ result: { value: "done" } }) }],
      registerProject: true,
    });

    const events: DomainEvent[] = [];
    dispatcher.subscribe(EVENT_TEST_DONE, (e) => events.push(e));

    await dispatcher.dispatch(testIntent());

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      projectId: PROJECT_ID,
      workspaceName: WORKSPACE_NAME,
      workspacePath: WORKSPACE_PATH,
      result: "done",
    });
  });

  it("does not dispatch project:resolve unless resolveProject is set", async () => {
    // No project:resolve operation registered — dispatch would throw
    // "No operation registered" if the skeleton tried to resolve the project.
    const { dispatcher } = createSetup({
      operation: new TestOperation(),
      workHandlers: [{ handler: async () => ({ result: { value: "ok" } }) }],
    });

    await expect(dispatcher.dispatch(testIntent())).resolves.toBe("ok");
  });
});
