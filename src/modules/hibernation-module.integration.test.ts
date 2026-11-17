// @vitest-environment node
/**
 * Integration tests for the hibernation module's backfill: the real
 * `project:open` operation, with stub resolve/register/discover hooks, a
 * recording set-metadata operation, and an in-memory filesystem holding the
 * screenshots. The mark/unmark writes are covered with the hibernate and wake
 * operations (`intents/hibernate-workspace.integration.test.ts`).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import type { IntentModule } from "../intents/lib/module";
import type { HookOutput, OperationSchemas } from "../intents/lib/operation";
import {
  OpenProjectOperation,
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  EVENT_PROJECT_OPENED,
  type DiscoverHookResult,
  type OpenProjectIntent,
  type ProjectOpenedEvent,
  type RegisterHookResult,
  type ResolveHookResult,
} from "../intents/open-project";
import {
  INTENT_SET_METADATA,
  SET_METADATA_OPERATION_ID,
  setMetadataPayloadSchema,
} from "../intents/set-metadata";
import type { DiscoveredWorkspace } from "../intents/contract";
import type { Project, ProjectId, WorkspaceName } from "../shared/api/types";
import { projPath, wsPath, workspaceRefIn } from "../shared/test-fixtures";
import { GIT_PROJECT_TYPE, gitProjectIdentifier } from "./git/ref";
import { createFileSystemMock, file } from "../boundaries/platform/filesystem.state-mock";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { createMockViewManager } from "../boundaries/shell/view-manager.test-utils";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import { buildScreenshotPath, createHibernationModule } from "./hibernation-module";

const PROJECT_PATH = projPath("/test/project");
const PROJECT_ID = "project-1234" as ProjectId;
const NOW = new Date("2026-11-17T10:00:00.000Z");
const SHOT_TIME = new Date("2026-09-15T08:30:00.000Z");
const RECORDED = "2026-10-31T12:00:00.000Z";

const setMetadataStubSchemas = {
  type: INTENT_SET_METADATA,
  payload: setMetadataPayloadSchema,
  result: z.void(),
} satisfies OperationSchemas;

interface Write {
  readonly workspaceRef: string;
  readonly key: string;
  readonly value: string | null;
}

function discovered(name: string, metadata: Record<string, string>): DiscoveredWorkspace {
  return {
    name: name as WorkspaceName,
    path: wsPath(`/test/project/workspaces/${name}`),
    metadata,
  };
}

function setup(options: { workspaces: DiscoveredWorkspace[]; failWritesFor?: string }): {
  open: () => Promise<{ project: Project; announced: ProjectOpenedEvent | undefined }>;
  writes: Write[];
  logger: ReturnType<typeof createBehavioralLogger>;
  screenshot: (name: string, mtime: Date) => void;
} {
  const dispatcher = createMockDispatcher();
  const fileSystem = createFileSystemMock();
  const pathProvider = createMockPathProvider();
  const logger = createBehavioralLogger();
  const writes: Write[] = [];

  dispatcher.registerOperation(new OpenProjectOperation());
  dispatcher.registerOperation({
    id: SET_METADATA_OPERATION_ID,
    schemas: setMetadataStubSchemas,
    execute: async (ctx) => {
      const { workspaceRef, key, value } = ctx.intent.payload;
      if (workspaceRef === options.failWritesFor) throw new Error("disk full");
      writes.push({ workspaceRef, key, value });
    },
  });

  const projectType: IntentModule = {
    name: "test-project-type",
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (): Promise<HookOutput<ResolveHookResult>> => ({
            result: {
              projectPath: PROJECT_PATH,
              type: GIT_PROJECT_TYPE,
              identifier: gitProjectIdentifier(PROJECT_PATH),
            },
          }),
        },
        register: {
          handler: async (): Promise<HookOutput<RegisterHookResult>> => ({
            result: { projectId: PROJECT_ID },
          }),
        },
        discover: {
          handler: async (): Promise<HookOutput<DiscoverHookResult>> => ({
            result: { workspaces: options.workspaces },
          }),
        },
      },
    },
  };
  dispatcher.registerModule(projectType);
  dispatcher.registerModule(
    createHibernationModule({
      dispatcher,
      fileSystem,
      pathProvider,
      viewManager: createMockViewManager(),
      logger,
      now: () => NOW,
    })
  );

  return {
    writes,
    logger,
    screenshot: (name, mtime) =>
      fileSystem.$.setEntry(
        buildScreenshotPath(pathProvider, PROJECT_ID, name),
        file("PNG", { mtime })
      ),
    open: async () => {
      let announced: ProjectOpenedEvent | undefined;
      dispatcher.subscribe(EVENT_PROJECT_OPENED, (event) => {
        announced = event as ProjectOpenedEvent;
      });
      const intent: OpenProjectIntent = {
        type: INTENT_OPEN_PROJECT,
        payload: { path: PROJECT_PATH },
      };
      const project = (await dispatcher.dispatch(intent)) as Project;
      return { project, announced };
    },
  };
}

const refOf = (name: string): string => workspaceRefIn(PROJECT_PATH, name);

describe("hibernation module: backfilling hibernated-at on project open", () => {
  it("gives a hibernated workspace without a time its screenshot's time, or now", async () => {
    const test = setup({
      workspaces: [
        discovered("shot", { hibernated: "true" }),
        discovered("background", { hibernated: "true" }),
        discovered("garbled", { hibernated: "true", "hibernated-at": "yesterday-ish" }),
        discovered("recorded", { hibernated: "true", "hibernated-at": RECORDED }),
      ],
    });
    test.screenshot("shot", SHOT_TIME);
    // A screenshot left beside a recorded time does not override it.
    test.screenshot("recorded", SHOT_TIME);

    const { project, announced } = await test.open();

    expect(test.writes).toEqual([
      { workspaceRef: refOf("shot"), key: "hibernated-at", value: SHOT_TIME.toISOString() },
      { workspaceRef: refOf("background"), key: "hibernated-at", value: NOW.toISOString() },
      { workspaceRef: refOf("garbled"), key: "hibernated-at", value: NOW.toISOString() },
    ]);
    const timesOf = (p: Project): Record<string, string | undefined> =>
      Object.fromEntries(p.workspaces.map((w) => [w.name, w.metadata["hibernated-at"]]));
    const expected = {
      shot: SHOT_TIME.toISOString(),
      background: NOW.toISOString(),
      garbled: NOW.toISOString(),
      recorded: RECORDED,
    };
    // The announcement already carries the times: no row ever lacks one.
    expect(timesOf(announced!.payload.project)).toEqual(expected);
    expect(timesOf(project)).toEqual(expected);
  });

  it("leaves a workspace whose write fails as discovered and warns; the others still fill", async () => {
    const test = setup({
      workspaces: [
        discovered("broken", { hibernated: "true" }),
        discovered("fine", { hibernated: "true" }),
      ],
      failWritesFor: refOf("broken"),
    });

    const { project } = await test.open();

    expect(project.workspaces.map((w) => [w.name, w.metadata["hibernated-at"]])).toEqual([
      ["broken", undefined],
      ["fine", NOW.toISOString()],
    ]);
    expect(test.logger.getMessagesByLevel("warn")).toEqual([
      {
        level: "warn",
        message: "hibernation: backfilling hibernated-at failed",
        context: { workspace: refOf("broken"), error: "disk full" },
      },
    ]);
  });
});
