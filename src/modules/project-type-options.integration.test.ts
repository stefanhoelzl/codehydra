// @vitest-environment node
/**
 * Integration tests for project types describing their own workspace options,
 * end to end: the type modules answer app:start's `register-project-types`,
 * the registry's `workspace.create` / `workspace.delete` take the merged
 * options, and the operations hand a type's handler only what its type
 * declares (behavioral mocks: the fake type next to git).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { createLockModule } from "./lock-module";
import { createRegistry } from "../api/entries";
import { describe as describeRegistry } from "../api/adapters/describe";
import { ApiError } from "../api/errors";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { IntentModule } from "../intents/lib/module";
import type { OperationSchemas } from "../intents/lib/operation";
import { defineHooks } from "../intents/declarations";
import { APP_START_OPERATION_ID, AppStartOperation, INTENT_APP_START } from "../intents/app-start";
import { ProjectTypeOptions } from "../intents/project-type-options";
import { OPEN_WORKSPACE_OPERATION_ID, OpenWorkspaceOperation } from "../intents/open-workspace";
import { DeleteWorkspaceOperation, INTENT_DELETE_WORKSPACE } from "../intents/delete-workspace";
import { INTENT_RESOLVE_PROJECT } from "../intents/resolve-project";
import { ResolveWorkspaceOperation } from "../intents/resolve-workspace";
import { INTENT_GET_ACTIVE_WORKSPACE } from "../intents/get-active-workspace";
import { createFakeProjectType, fakeProjectRef } from "./fake-project-type.test-utils";
import { createTestWorkspaceRegistry } from "./workspace-registry.test-utils";
import { createTestGitModule } from "./git/git.test-utils";
import { projectPathSchema, type ProjectId, type WorkspaceRef } from "../intents/contract";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { makeWorkspaceRef } from "../utils/ref";
import { testPath } from "../shared/test-fixtures";

const FOLDERS = testPath("/projects/folders").toString();
const FAKE_REF = fakeProjectRef(FOLDERS);

/** A stand-in project type module answering only `register-project-types`. */
function typeModule(type: string, create: Record<string, unknown>): IntentModule {
  return {
    name: `type-${type}`,
    hooks: defineHooks({
      [APP_START_OPERATION_ID]: {
        "register-project-types": {
          handler: async () => ({ result: { type, create } as never }),
        },
      },
    }),
  };
}

/** Run app:start over these modules; the holder it seals. */
async function startWith(modules: readonly IntentModule[]): Promise<ProjectTypeOptions> {
  const dispatcher = createMockDispatcher();
  const projectTypes = new ProjectTypeOptions();
  dispatcher.registerOperation(
    new AppStartOperation(
      createMockAccessor<ConfigAgentType>("agent", "claude"),
      () => "user",
      projectTypes
    )
  );
  for (const module of modules) dispatcher.registerModule(module);
  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as never);
  return projectTypes;
}

/** The registry over a dispatcher, with these project type options. */
function registryOver(dispatcher: Dispatcher, projectTypes: ProjectTypeOptions) {
  return createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      processes: { list: async () => null },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
      projectTypes,
    },
    SILENT_LOGGER
  );
}

const CALLER = { workspaceRef: null, cwd: null, signal: new AbortController().signal };

describe("register-project-types", () => {
  it("seals what every project type module answers, before start", async () => {
    const { registry } = createTestWorkspaceRegistry();
    const projectTypes = await startWith([
      createTestGitModule(),
      createFakeProjectType(registry).module,
    ]);

    expect(projectTypes.names("create")).toEqual(["base", "tracking", "template"]);
    expect(projectTypes.names("delete")).toEqual(["keepBranch", "archive"]);
  });

  it("fails startup when two types declare one option differently", async () => {
    await expect(
      startWith([
        typeModule("one", { start: { kind: "text" } }),
        typeModule("two", { start: { kind: "checkbox" } }),
      ])
    ).rejects.toThrow(/"one" and "two" both declare the create option "start", differently/);
  });

  it("fails startup when a type names an option like a core field", async () => {
    const dispatcher = createMockDispatcher();
    const projectTypes = new ProjectTypeOptions();
    // The registry claims its core fields when it is built, before app:start.
    registryOver(dispatcher, projectTypes);
    dispatcher.registerOperation(
      new AppStartOperation(
        createMockAccessor<ConfigAgentType>("agent", "claude"),
        () => "user",
        projectTypes
      )
    );
    dispatcher.registerModule(typeModule("other", { prompt: { kind: "text" } }));

    await expect(
      dispatcher.dispatch({ type: INTENT_APP_START, payload: {} } as never)
    ).rejects.toThrow(/"other" declares the create option "prompt"/);
  });
});

/**
 * The real workspace:open / workspace:delete operations, the core workspace
 * registry and the fake type, with the few hook points the fake does not
 * answer stubbed: a URL to open the workspace under.
 */
async function fakeTypeSetup() {
  const dispatcher = createMockDispatcher();
  const { registry } = createTestWorkspaceRegistry();
  const fake = createFakeProjectType(registry);
  const projectTypes = await startWith([createTestGitModule(), fake.module]);

  dispatcher.registerOperation(new OpenWorkspaceOperation(projectTypes));
  dispatcher.registerOperation(new DeleteWorkspaceOperation(projectTypes));
  dispatcher.registerOperation(new ResolveWorkspaceOperation());
  const stub = <S extends OperationSchemas>(id: string, schemas: S, result: unknown) =>
    dispatcher.registerOperation({ id, schemas, execute: async () => result as never });
  stub(
    "resolve-project",
    { type: INTENT_RESOLVE_PROJECT, payload: z.unknown(), result: z.unknown() },
    {
      projectId: "folders-1" as ProjectId,
      projectRef: FAKE_REF,
      projectPath: projectPathSchema.parse(FOLDERS),
      projectName: "folders",
    }
  );
  stub(
    "get-active-workspace",
    { type: INTENT_GET_ACTIVE_WORKSPACE, payload: z.unknown(), result: z.unknown() },
    { workspaceRef: null }
  );
  dispatcher.registerModule(registry);
  dispatcher.registerModule(fake.module);
  dispatcher.registerModule({
    name: "url",
    hooks: defineHooks({
      [OPEN_WORKSPACE_OPERATION_ID]: {
        finalize: { handler: async () => ({ result: { workspaceUrl: "http://127.0.0.1/ws" } }) },
      },
    }),
  });
  registry.openProject({ ref: FAKE_REF, path: projectPathSchema.parse(FOLDERS) });

  return { dispatcher, fake, projectTypes, api: registryOver(dispatcher, projectTypes) };
}

describe("a project type's own options, end to end", () => {
  it("offers the fake type's options on CLI and MCP beside git's", async () => {
    const { api } = await fakeTypeSetup();
    const create = describeRegistry(api, "cli").find((d) => d.name === "workspace.create")!;

    expect(Object.keys((create.inputSchema as { properties: object }).properties)).toEqual([
      "project",
      "name",
      "base",
      "tracking",
      "template",
      "prompt",
      "agent",
      "model",
      "permissionMode",
      "agentName",
      "stealFocus",
    ]);
  });

  it("hands the fake type's create handler its option, from a `ch ws create` call", async () => {
    const { api, fake } = await fakeTypeSetup();

    await api.invoke(api.get("workspace.create"), CALLER, {
      project: FAKE_REF,
      name: "notes",
      template: "readme",
    });

    expect(fake.created).toEqual(["notes"]);
    expect(fake.createOptions).toEqual([{ template: "readme" }]);
  });

  it("applies the fake type's default when the caller gives none", async () => {
    const { api, fake } = await fakeTypeSetup();

    await api.invoke(api.get("workspace.create"), CALLER, { project: FAKE_REF, name: "notes" });

    expect(fake.createOptions).toEqual([{ template: "empty" }]);
  });

  it("refuses git's option for a fake project as a usage error, creating nothing", async () => {
    const { api, fake } = await fakeTypeSetup();

    const failure = await api
      .invoke(api.get("workspace.create"), CALLER, {
        project: FAKE_REF,
        name: "notes",
        base: "main",
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).category).toBe("usage");
    expect(fake.created).toEqual([]);
  });

  it("hands the fake type's delete handler its option, and refuses git's", async () => {
    const { api, fake, dispatcher } = await fakeTypeSetup();
    await api.invoke(api.get("workspace.create"), CALLER, { project: FAKE_REF, name: "notes" });
    const workspace: WorkspaceRef = makeWorkspaceRef(FAKE_REF, "notes");

    await expect(
      dispatcher.dispatch({
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspaceRef: workspace,
          options: { keepBranch: true },
          force: false,
          removeWorktree: true,
        },
      })
    ).rejects.toMatchObject({ category: "usage" });
    expect(fake.deleteOptions).toEqual([]);

    await dispatcher.dispatch({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspaceRef: workspace,
        options: { archive: true },
        force: false,
        removeWorktree: true,
      },
    });
    expect(fake.deleteOptions).toEqual([{ archive: true }]);
  });
});
