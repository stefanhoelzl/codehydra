// @vitest-environment node
/**
 * Integration tests for list-projects operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hooks -> result,
 * using mock hook modules for "list-projects" and "list-workspaces" hook points.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { createMockLogger } from "../../services/logging/logging.test-utils";

import {
  ListProjectsOperation,
  LIST_PROJECTS_OPERATION_ID,
  INTENT_LIST_PROJECTS,
} from "./list-projects";
import type {
  ListProjectsIntent,
  ListProjectsHookResult,
  ListWorkspacesHookResult,
} from "./list-projects";
import type { IntentModule } from "../intents/infrastructure/module";
import type { Project, ProjectId } from "../../shared/api/types";
import type { InternalWorkspace } from "./list-projects";
import { Path } from "../../services/platform/path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_A_ID = "project-a-ea0135bc" as ProjectId;
const PROJECT_A_PATH = "/repos/project-a";
const PROJECT_B_ID = "project-b-fb1246cd" as ProjectId;
const PROJECT_B_PATH = "/repos/project-b";

function makeWorkspace(name: string, projectPath: string, branch: string): InternalWorkspace {
  return {
    name,
    path: new Path(`${projectPath}/.codehydra/workspaces/${name}`),
    branch,
    metadata: { base: "main" },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
}

function createTestSetup(
  projectsHandler: () => Promise<ListProjectsHookResult>,
  workspacesHandler: () => Promise<ListWorkspacesHookResult>
): TestSetup {
  const dispatcher = new Dispatcher({ logger: createMockLogger() });

  dispatcher.registerOperation(INTENT_LIST_PROJECTS, new ListProjectsOperation());

  const projectModule: IntentModule = {
    name: "test-projects",
    hooks: {
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-projects": {
          handler: projectsHandler,
        },
      },
    },
  };

  const workspaceModule: IntentModule = {
    name: "test-workspaces",
    hooks: {
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-workspaces": {
          handler: workspacesHandler,
        },
      },
    },
  };

  dispatcher.registerModule(projectModule);
  dispatcher.registerModule(workspaceModule);

  return { dispatcher };
}

// =============================================================================
// Helpers
// =============================================================================

function listProjectsIntent(): ListProjectsIntent {
  return {
    type: INTENT_LIST_PROJECTS,
    payload: {},
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("ListProjects Operation", () => {
  describe("empty state", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup(
        async () => ({ projects: [] }),
        async () => ({ entries: [] })
      );
    });

    it("returns empty array when no projects exist", async () => {
      const result = (await setup.dispatcher.dispatch(listProjectsIntent())) as Project[];

      expect(result).toEqual([]);
    });
  });

  describe("single project with workspaces", () => {
    let setup: TestSetup;
    const ws1 = makeWorkspace("feature-x", PROJECT_A_PATH, "feature-x");
    const ws2 = makeWorkspace("bugfix-y", PROJECT_A_PATH, "bugfix-y");

    beforeEach(() => {
      setup = createTestSetup(
        async () => ({
          projects: [{ projectId: PROJECT_A_ID, name: "project-a", path: PROJECT_A_PATH }],
        }),
        async () => ({
          entries: [{ projectPath: PROJECT_A_PATH, workspaces: [ws1, ws2] }],
        })
      );
    });

    it("returns project with workspaces converted to IPC format", async () => {
      const result = (await setup.dispatcher.dispatch(listProjectsIntent())) as Project[];

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(PROJECT_A_ID);
      expect(result[0]!.name).toBe("project-a");
      expect(result[0]!.path).toBe(PROJECT_A_PATH);
      expect(result[0]!.workspaces).toHaveLength(2);
      expect(result[0]!.workspaces[0]!.projectId).toBe(PROJECT_A_ID);
      expect(result[0]!.workspaces[0]!.name).toBe("feature-x");
      expect(result[0]!.workspaces[0]!.path).toBe(ws1.path.toString());
      expect(result[0]!.workspaces[1]!.name).toBe("bugfix-y");
    });
  });

  describe("multiple projects with correct workspace grouping", () => {
    let setup: TestSetup;
    const wsA = makeWorkspace("ws-a", PROJECT_A_PATH, "ws-a");
    const wsB = makeWorkspace("ws-b", PROJECT_B_PATH, "ws-b");

    beforeEach(() => {
      setup = createTestSetup(
        async () => ({
          projects: [
            { projectId: PROJECT_A_ID, name: "project-a", path: PROJECT_A_PATH },
            { projectId: PROJECT_B_ID, name: "project-b", path: PROJECT_B_PATH },
          ],
        }),
        async () => ({
          entries: [
            { projectPath: PROJECT_A_PATH, workspaces: [wsA] },
            { projectPath: PROJECT_B_PATH, workspaces: [wsB] },
          ],
        })
      );
    });

    it("groups workspaces under the correct project", async () => {
      const result = (await setup.dispatcher.dispatch(listProjectsIntent())) as Project[];

      expect(result).toHaveLength(2);

      const projectA = result.find((p) => p.id === PROJECT_A_ID)!;
      expect(projectA.workspaces).toHaveLength(1);
      expect(projectA.workspaces[0]!.name).toBe("ws-a");
      expect(projectA.workspaces[0]!.projectId).toBe(PROJECT_A_ID);

      const projectB = result.find((p) => p.id === PROJECT_B_ID)!;
      expect(projectB.workspaces).toHaveLength(1);
      expect(projectB.workspaces[0]!.name).toBe("ws-b");
      expect(projectB.workspaces[0]!.projectId).toBe(PROJECT_B_ID);
    });
  });

  describe("project with no matching workspaces", () => {
    let setup: TestSetup;

    beforeEach(() => {
      setup = createTestSetup(
        async () => ({
          projects: [{ projectId: PROJECT_A_ID, name: "project-a", path: PROJECT_A_PATH }],
        }),
        async () => ({ entries: [] })
      );
    });

    it("returns project with empty workspaces array", async () => {
      const result = (await setup.dispatcher.dispatch(listProjectsIntent())) as Project[];

      expect(result).toHaveLength(1);
      expect(result[0]!.workspaces).toEqual([]);
    });
  });

  describe("workspace data for unknown project", () => {
    let setup: TestSetup;
    const ws = makeWorkspace("orphan", "/repos/unknown", "orphan");

    beforeEach(() => {
      setup = createTestSetup(
        async () => ({
          projects: [{ projectId: PROJECT_A_ID, name: "project-a", path: PROJECT_A_PATH }],
        }),
        async () => ({
          entries: [{ projectPath: "/repos/unknown", workspaces: [ws] }],
        })
      );
    });

    it("skips workspaces with no matching project entry", async () => {
      const result = (await setup.dispatcher.dispatch(listProjectsIntent())) as Project[];

      expect(result).toHaveLength(1);
      expect(result[0]!.workspaces).toEqual([]);
    });
  });

  describe("error propagation", () => {
    it("propagates list-projects hook errors", async () => {
      const setup = createTestSetup(
        async () => {
          throw new Error("project hook failed");
        },
        async () => ({ entries: [] })
      );

      await expect(setup.dispatcher.dispatch(listProjectsIntent())).rejects.toThrow(
        "project hook failed"
      );
    });

    it("propagates list-workspaces hook errors", async () => {
      const setup = createTestSetup(
        async () => ({ projects: [] }),
        async () => {
          throw new Error("workspace hook failed");
        }
      );

      await expect(setup.dispatcher.dispatch(listProjectsIntent())).rejects.toThrow(
        "workspace hook failed"
      );
    });
  });
});
