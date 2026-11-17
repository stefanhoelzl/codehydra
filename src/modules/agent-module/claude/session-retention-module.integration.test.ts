// @vitest-environment node
/**
 * Integration tests for the session retention module: it reads the open
 * projects' hibernated workspaces through `project:list` and hands the
 * `cleanupPeriodDays` that keeps their Claude transcripts to the server manager.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging.test-utils";
import type { Operation } from "../../../intents/lib/operation";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../../intents/list-projects";
import { EVENT_PROJECT_OPENED } from "../../../intents/open-project";
import { EVENT_WORKSPACE_HIBERNATED } from "../../../intents/hibernate-workspace";
import { EVENT_WORKSPACE_WOKEN } from "../../../intents/wake-workspace";
import type { Project, ProjectId, WorkspaceName } from "../../../shared/api/types";
import { projPath, wsPath, testPath, workspaceRefIn } from "../../../shared/test-fixtures";
import { gitProjectRef } from "../../git/ref";
import {
  cleanupPeriodDaysFor,
  createSessionRetentionModule,
  RETENTION_MARGIN_DAYS,
} from "./session-retention-module";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

const PROJECT_PATH = projPath(testPath("/projects/repo").toString());
const PROJECT_REF = gitProjectRef(PROJECT_PATH);

function project(workspaces: Record<string, Record<string, string>>): Project {
  return {
    ref: PROJECT_REF,
    id: "project-1" as ProjectId,
    name: "repo",
    path: PROJECT_PATH,
    workspaces: Object.entries(workspaces).map(([name, metadata]) => ({
      ref: workspaceRefIn(PROJECT_PATH, name),
      projectId: "project-1" as ProjectId,
      name: name as WorkspaceName,
      branch: name,
      metadata: { base: "main", ...metadata },
      path: wsPath(`${PROJECT_PATH}/${name}`),
    })),
  };
}

function createSetup() {
  const dispatcher = createMockDispatcher();
  let listed: Project[] = [];
  const schemas = {
    type: INTENT_LIST_PROJECTS,
    payload: z.custom<ListProjectsIntent["payload"]>(),
    result: z.custom<Project[]>(),
    events: {},
  };
  dispatcher.registerOperation(
    new (class implements Operation<typeof schemas> {
      readonly id = "list-projects";
      readonly schemas = schemas;
      async execute(): Promise<Project[]> {
        return listed;
      }
    })()
  );

  const written: (number | undefined)[] = [];
  const module = createSessionRetentionModule({
    dispatcher,
    serverManager: {
      setCleanupPeriodDays: async (days) => {
        written.push(days);
      },
    },
    logger: SILENT_LOGGER,
    now: () => NOW,
  });
  const identity = {
    workspaceRef: workspaceRefIn(PROJECT_PATH, "a"),
    projectRef: PROJECT_REF,
    workspaceName: "a" as WorkspaceName,
    projectId: "project-1" as ProjectId,
  };

  return {
    module,
    written,
    list: (projects: Project[]) => {
      listed = projects;
    },
    hibernated: () =>
      module.events![EVENT_WORKSPACE_HIBERNATED]!.handler({
        type: EVENT_WORKSPACE_HIBERNATED,
        payload: identity,
      }),
    woken: () =>
      module.events![EVENT_WORKSPACE_WOKEN]!.handler({
        type: EVENT_WORKSPACE_WOKEN,
        payload: identity,
      }),
    opened: (p: Project) =>
      module.events![EVENT_PROJECT_OPENED]!.handler({
        type: EVENT_PROJECT_OPENED,
        payload: { project: p },
      }),
  };
}

describe("cleanupPeriodDaysFor", () => {
  it("leaves Claude's default when no workspace has a hibernation time", () => {
    expect(cleanupPeriodDaysFor([], NOW)).toBeUndefined();
    expect(cleanupPeriodDaysFor(["not a date"], NOW)).toBeUndefined();
  });

  it("covers the oldest hibernation plus the margin, rounding its age up", () => {
    expect(cleanupPeriodDaysFor([daysAgo(3), daysAgo(45.2), daysAgo(10)], NOW)).toBe(
      46 + RETENTION_MARGIN_DAYS
    );
  });

  it("covers a workspace hibernated just now", () => {
    expect(cleanupPeriodDaysFor([new Date(NOW).toISOString()], NOW)).toBe(RETENTION_MARGIN_DAYS);
  });
});

describe("session retention module", () => {
  it("raises retention to cover the oldest hibernated workspace when one hibernates", async () => {
    const s = createSetup();
    s.list([
      project({
        a: { hibernated: "true", "hibernated-at": daysAgo(0) },
        b: { hibernated: "true", "hibernated-at": daysAgo(40) },
        // Awake workspaces do not count, even with a stale timestamp.
        c: { "hibernated-at": daysAgo(400) },
      }),
    ]);

    await s.hibernated();

    expect(s.written).toEqual([40 + RETENTION_MARGIN_DAYS]);
  });

  it("ignores workspaces hibernated before hibernation times were recorded", async () => {
    const s = createSetup();
    s.list([project({ legacy: { hibernated: "true" } })]);

    await s.hibernated();

    expect(s.written).toEqual([undefined]);
  });

  it("drops back to Claude's default once nothing is hibernated", async () => {
    const s = createSetup();
    s.list([project({ a: { hibernated: "true", "hibernated-at": daysAgo(5) } })]);
    await s.hibernated();
    s.list([project({ a: {} })]);

    await s.woken();

    expect(s.written).toEqual([5 + RETENTION_MARGIN_DAYS, undefined]);
  });

  it("counts the project being opened even before the list carries it", async () => {
    const s = createSetup();
    s.list([]);

    await s.opened(project({ a: { hibernated: "true", "hibernated-at": daysAgo(20) } }));

    expect(s.written).toEqual([20 + RETENTION_MARGIN_DAYS]);
  });
});
