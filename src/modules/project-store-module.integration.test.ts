// @vitest-environment node
/**
 * Integration tests for the core project store: records, ids, badge colors and
 * the open-project map, for projects of any type. The store reads no project
 * type's config; the git type's contributions are covered in
 * local-project-module.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import nodePath from "path";

import {
  assignColor,
  createProjectStoreModule,
  generateProjectId,
  type ProjectStoreModule,
} from "./project-store-module";
import { PROJECT_COLOR_COUNT } from "../shared/ui-state";
import {
  OPEN_PROJECT_OPERATION_ID,
  INTENT_OPEN_PROJECT,
  type ProjectTypeConfig,
  type RegisterHookInput,
  type RegisterHookResult,
} from "../intents/open-project";
import type { schemas as openProjectSchemas } from "../intents/open-project";
import {
  CLOSE_PROJECT_OPERATION_ID,
  INTENT_CLOSE_PROJECT,
  type CloseHookInput,
} from "../intents/close-project";
import type { schemas as closeProjectSchemas } from "../intents/close-project";
import { APP_READY_OPERATION_ID, type AppReadyIntent } from "../intents/app-ready";
import type { schemas as appReadySchemas } from "../intents/app-ready";
import { RESOLVE_PROJECT_OPERATION_ID } from "../intents/resolve-project";
import type { schemas as resolveProjectSchemas } from "../intents/resolve-project";
import { LIST_PROJECTS_OPERATION_ID } from "../intents/list-projects";
import type { schemas as listProjectsSchemas } from "../intents/list-projects";
import type {
  HookContext,
  HookOutput,
  HookResult,
  OperationSchemas,
  ResolvedHooks,
} from "../intents/lib/operation";
import type { IntentModule } from "../intents/lib/module";
import { createFileSystemMock, directory } from "../boundaries/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { managedProjectDirName, projectDirName } from "../boundaries/platform/paths";
import { Path } from "../utils/path/path";
import { projectRefFor } from "../utils/ref";
import { projPath, testPath } from "../shared/test-fixtures";
import type { ProjectPath } from "../intents/contract";

// =============================================================================
// Setup
// =============================================================================

const PROJECTS_DIR = testPath("/test/app-data/projects").toNative();
const PATH_A = projPath("/test/alpha");
const PATH_B = projPath("/test/beta");
const PATH_C = projPath("/test/gamma");
const REPO_URL = "https://github.com/user/repo.git";

type MockFs = ReturnType<typeof createFileSystemMock>;

function hooksOf<S extends OperationSchemas>(
  module: IntentModule,
  operationId: string
): ResolvedHooks<S> {
  const opHooks = module.hooks?.[operationId] ?? {};
  return {
    collect: async <T>(hookPointId: string, ctx: HookContext): Promise<HookResult<T>> => {
      const hookHandler = opHooks[hookPointId];
      if (!hookHandler) return { results: [], errors: [], capabilities: {} };
      try {
        const output = await hookHandler.handler(ctx);
        const result = (output as HookOutput<T> | undefined)?.result;
        return { results: result != null ? [result] : [], errors: [], capabilities: {} };
      } catch (error) {
        return { results: [], errors: [error as Error], capabilities: {} };
      }
    },
  };
}

interface Setup {
  store: ProjectStoreModule;
  fs: MockFs;
  open: ResolvedHooks<typeof openProjectSchemas>;
  close: ResolvedHooks<typeof closeProjectSchemas>;
  ready: ResolvedHooks<typeof appReadySchemas>;
  resolveProject: ResolvedHooks<typeof resolveProjectSchemas>;
  listProjects: ResolvedHooks<typeof listProjectsSchemas>;
}

function createSetup(): Setup {
  const fs = createFileSystemMock({ entries: { [PROJECTS_DIR]: directory() } });
  const store = createProjectStoreModule({
    projectsDir: PROJECTS_DIR,
    fs,
    platform: "linux",
    logger: SILENT_LOGGER,
  });
  return {
    store,
    fs,
    open: hooksOf(store, OPEN_PROJECT_OPERATION_ID),
    close: hooksOf(store, CLOSE_PROJECT_OPERATION_ID),
    ready: hooksOf(store, APP_READY_OPERATION_ID),
    resolveProject: hooksOf(store, RESOLVE_PROJECT_OPERATION_ID),
    listProjects: hooksOf(store, LIST_PROJECTS_OPERATION_ID),
  };
}

/** A git-shaped config for a local project: what the git type reports at resolve. */
const gitConfig = (path: ProjectPath): ProjectTypeConfig => ({ path: new Path(path).toString() });

function register(
  setup: Setup,
  path: ProjectPath,
  options: { type?: string; config?: ProjectTypeConfig; remoteUrl?: string } = {}
): Promise<HookResult<RegisterHookResult>> {
  const { type = "git", config = gitConfig(path), remoteUrl } = options;
  return setup.open.collect("register", {
    intent: { type: INTENT_OPEN_PROJECT, payload: { path } },
    projectPath: path,
    projectRef: projectRefFor(path, remoteUrl),
    ...(remoteUrl !== undefined && { remoteUrl }),
    type,
    config,
  } satisfies RegisterHookInput);
}

function close(setup: Setup, path: ProjectPath): ReturnType<Setup["close"]["collect"]> {
  return setup.close.collect("close", {
    intent: { type: INTENT_CLOSE_PROJECT, payload: { projectRef: projectRefFor(path) } },
    projectRef: projectRefFor(path),
    projectPath: path,
    removeLocalRepo: false,
  } satisfies CloseHookInput);
}

function appReadyIntent(): AppReadyIntent {
  return { type: "app:ready", payload: {} as AppReadyIntent["payload"] };
}

const recordFile = (dirName: string): string => nodePath.join(PROJECTS_DIR, dirName, "config.json");

function readRecord(fs: MockFs, dirName: string): unknown {
  const entry = fs.$.entries.get(new Path(recordFile(dirName)).toString());
  return entry?.type === "file" ? JSON.parse(String(entry.content)) : undefined;
}

function writeRecord(fs: MockFs, dirName: string, content: unknown): void {
  fs.$.setEntry(nodePath.join(PROJECTS_DIR, dirName), { type: "directory" });
  fs.$.setEntry(recordFile(dirName), {
    type: "file",
    content: typeof content === "string" ? content : JSON.stringify(content),
  });
}

const dirOf = (path: ProjectPath): string => projectDirName(new Path(path).toString());

// =============================================================================
// Tests
// =============================================================================

describe("ProjectStoreModule", () => {
  describe("project:open register", () => {
    it("persists a new project's type, config and color under its path-named directory", async () => {
      const setup = createSetup();

      const { results, errors } = await register(setup, PATH_A);

      expect(errors).toHaveLength(0);
      expect(results[0]).toEqual({
        projectId: generateProjectId(PATH_A, "linux"),
        name: "alpha",
      });
      expect(readRecord(setup.fs, dirOf(PATH_A))).toEqual({
        type: "git",
        config: gitConfig(PATH_A),
        color: 0,
      });
    });

    it("names a new project with an origin's record directory after the origin", async () => {
      const setup = createSetup();

      await register(setup, PATH_A, { config: { remoteUrl: REPO_URL }, remoteUrl: REPO_URL });

      expect(readRecord(setup.fs, managedProjectDirName(REPO_URL))).toEqual({
        type: "git",
        config: { remoteUrl: REPO_URL },
        color: 0,
      });
      expect(readRecord(setup.fs, dirOf(PATH_A))).toBeUndefined();
    });

    it("persists a type's config as is, whatever it holds", async () => {
      const setup = createSetup();
      const config = { server: "https://example.test", nested: { ids: [1, 2] } };

      await register(setup, PATH_A, { type: "other", config });

      expect(readRecord(setup.fs, dirOf(PATH_A))).toEqual({ type: "other", config, color: 0 });
      const { results } = await setup.ready.collect("load-projects", { intent: appReadyIntent() });
      expect(results[0]!.projects).toEqual([{ type: "other", config }]);
    });

    it("finds an existing record by type and config, wherever it lives, and keeps it there", async () => {
      const setup = createSetup();
      writeRecord(setup.fs, "somewhere-else", {
        type: "git",
        config: { remoteUrl: REPO_URL, path: new Path(PATH_A).toString() },
        color: 4,
      });

      // Same config, keys in another order
      await register(setup, PATH_A, {
        config: { path: new Path(PATH_A).toString(), remoteUrl: REPO_URL },
        remoteUrl: REPO_URL,
      });

      expect(setup.store.projectColor(projectRefFor(PATH_A, REPO_URL))).toBe(4);
      expect(readRecord(setup.fs, managedProjectDirName(REPO_URL))).toBeUndefined();
    });

    it("returns alreadyOpen for a project already open, without writing", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      await setup.fs.unlink(new Path(recordFile(dirOf(PATH_A))));

      const { results } = await register(setup, PATH_A);

      expect(results[0]!.alreadyOpen).toBe(true);
      expect(readRecord(setup.fs, dirOf(PATH_A))).toBeUndefined();
    });

    it("refuses a project no type resolved", async () => {
      const setup = createSetup();

      const { errors } = await setup.open.collect("register", {
        intent: { type: INTENT_OPEN_PROJECT, payload: { path: PATH_A } },
        projectPath: PATH_A,
        projectRef: projectRefFor(PATH_A),
      } satisfies RegisterHookInput);

      expect(errors[0]?.message).toContain("No project type resolved");
      expect(setup.store.isOpen(PATH_A)).toBe(false);
    });
  });

  describe("records written before project types", () => {
    it("reads a path record as a git project", async () => {
      const setup = createSetup();
      writeRecord(setup.fs, dirOf(PATH_A), { path: new Path(PATH_A).toString(), color: 2 });
      writeRecord(setup.fs, managedProjectDirName(REPO_URL), { remoteUrl: REPO_URL });

      const records = await setup.store.records();

      expect(records).toHaveLength(2);
      expect(records).toEqual(
        expect.arrayContaining([
          {
            type: "git",
            config: { path: new Path(PATH_A).toString() },
            color: 2,
            dirName: dirOf(PATH_A),
          },
          {
            type: "git",
            config: { remoteUrl: REPO_URL },
            dirName: managedProjectDirName(REPO_URL),
          },
        ])
      );
    });

    it("rewrites a legacy record in the new shape when it is next written", async () => {
      const setup = createSetup();
      // No color yet: opening assigns one, which writes the record
      writeRecord(setup.fs, dirOf(PATH_A), { path: new Path(PATH_A).toString() });

      await register(setup, PATH_A);

      expect(readRecord(setup.fs, dirOf(PATH_A))).toEqual({
        type: "git",
        config: gitConfig(PATH_A),
        color: 0,
      });
    });

    it("leaves a legacy record alone while nothing about it changes", async () => {
      const setup = createSetup();
      const legacy = { path: new Path(PATH_A).toString(), color: 0 };
      writeRecord(setup.fs, dirOf(PATH_A), legacy);

      await register(setup, PATH_A);

      expect(readRecord(setup.fs, dirOf(PATH_A))).toEqual(legacy);
    });

    it("skips records it cannot read", async () => {
      const setup = createSetup();
      writeRecord(setup.fs, "malformed", "{not json");
      writeRecord(setup.fs, "empty", {});
      writeRecord(setup.fs, "no-config", { type: "git" });
      writeRecord(setup.fs, dirOf(PATH_A), { path: new Path(PATH_A).toString() });

      const records = await setup.store.records();

      expect(records.map((record) => record.dirName)).toEqual([dirOf(PATH_A)]);
    });
  });

  describe("app:ready load-projects", () => {
    it("returns every saved project's type and config", async () => {
      const setup = createSetup();
      writeRecord(setup.fs, dirOf(PATH_A), { path: new Path(PATH_A).toString() });
      writeRecord(setup.fs, "other", { type: "other", config: { id: 7 }, color: 1 });

      const { results, errors } = await setup.ready.collect("load-projects", {
        intent: appReadyIntent(),
      });

      expect(errors).toHaveLength(0);
      expect(results[0]!.projects).toEqual(
        expect.arrayContaining([
          { type: "git", config: { path: new Path(PATH_A).toString() } },
          { type: "other", config: { id: 7 } },
        ])
      );
      // Loading opens nothing: project:open register does
      expect(setup.store.isOpen(PATH_A)).toBe(false);
    });

    it("returns none when nothing is saved", async () => {
      const setup = createSetup();

      const { results } = await setup.ready.collect("load-projects", { intent: appReadyIntent() });

      expect(results[0]!.projects).toEqual([]);
    });
  });

  describe("project:close close", () => {
    it("drops the project and removes its record and its directory", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);

      const { results, errors } = await close(setup, PATH_A);

      expect(errors).toHaveLength(0);
      expect(results[0]).toEqual({ otherProjectsExist: false });
      expect(setup.store.isOpen(PATH_A)).toBe(false);
      expect(setup.fs.$.entries.has(new Path(PROJECTS_DIR, dirOf(PATH_A)).toString())).toBe(false);
    });

    it("keeps a record directory that still holds its type's files", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      const worktrees = nodePath.join(PROJECTS_DIR, dirOf(PATH_A), "workspaces", "feature");
      setup.fs.$.setEntry(worktrees, { type: "directory" });

      await close(setup, PATH_A);

      expect(readRecord(setup.fs, dirOf(PATH_A))).toBeUndefined();
      expect(setup.fs.$.entries.has(new Path(worktrees).toString())).toBe(true);
    });

    it("reports whether other projects are still open", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      await register(setup, PATH_B);

      const { results } = await close(setup, PATH_A);

      expect(results[0]).toEqual({ otherProjectsExist: true });
    });
  });

  describe("resolve-project and list-projects", () => {
    it("resolves and lists open projects only", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      const refA = projectRefFor(PATH_A);
      const idA = generateProjectId(PATH_A, "linux");

      const resolved = await setup.resolveProject.collect("resolve", {
        intent: { type: "project:resolve", payload: { projectRef: refA } },
        projectRef: refA,
      });
      const unknown = await setup.resolveProject.collect("resolve", {
        intent: { type: "project:resolve", payload: { projectRef: projectRefFor(PATH_B) } },
        projectRef: projectRefFor(PATH_B),
      });
      const listed = await setup.listProjects.collect("list-projects", {
        intent: { type: "project:list", payload: {} },
      });

      expect(resolved.results[0]).toEqual({
        projectId: idA,
        projectPath: new Path(PATH_A).toString(),
        projectName: "alpha",
      });
      expect(unknown.results[0]).toEqual({});
      expect(listed.results[0]!.projects).toEqual([
        { ref: refA, projectId: idA, name: "alpha", path: new Path(PATH_A).toString() },
      ]);
    });
  });

  describe("badge colors", () => {
    const colorOf = (setup: Setup, path: ProjectPath): number | undefined =>
      setup.store.projectColor(projectRefFor(path));

    it("gives each project opened the lowest free color and stores it in its record", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      await register(setup, PATH_B);

      expect(colorOf(setup, PATH_A)).toBe(0);
      expect(colorOf(setup, PATH_B)).toBe(1);
      expect(readRecord(setup.fs, dirOf(PATH_B))).toMatchObject({ color: 1 });
    });

    it("keeps the color a record holds", async () => {
      const setup = createSetup();
      writeRecord(setup.fs, dirOf(PATH_A), { type: "git", config: gitConfig(PATH_A), color: 5 });

      await register(setup, PATH_A);

      expect(colorOf(setup, PATH_A)).toBe(5);
    });

    it("gives a record whose color another open project has the lowest free one", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      writeRecord(setup.fs, dirOf(PATH_B), { type: "git", config: gitConfig(PATH_B), color: 0 });

      await register(setup, PATH_B);

      expect(colorOf(setup, PATH_B)).toBe(1);
      expect(readRecord(setup.fs, dirOf(PATH_B))).toMatchObject({ color: 1 });
    });

    it("frees a closed project's color for the next one opened", async () => {
      const setup = createSetup();
      await register(setup, PATH_A);
      await register(setup, PATH_B);
      await close(setup, PATH_A);
      await register(setup, PATH_C);

      expect(colorOf(setup, PATH_A)).toBeUndefined();
      expect(colorOf(setup, PATH_C)).toBe(0);
    });

    it("never gives two projects opened at once the same color", async () => {
      const setup = createSetup();
      await Promise.all([
        register(setup, PATH_A),
        register(setup, PATH_B),
        register(setup, PATH_C),
      ]);

      const colors = [PATH_A, PATH_B, PATH_C].map((path) => colorOf(setup, path));
      expect(new Set(colors).size).toBe(3);
    });

    it("repeats the colors in order once every one is taken", () => {
      const all = Array.from({ length: PROJECT_COLOR_COUNT }, (_, index) => index);
      expect(assignColor(undefined, all)).toBe(0);
      expect(assignColor(undefined, [...all, 0])).toBe(1);
      expect(assignColor(3, [0, 1])).toBe(3);
      expect(assignColor(PROJECT_COLOR_COUNT, [])).toBe(0);
    });
  });
});

describe("generateProjectId", () => {
  it("names the id after the basename and hashes the normalized path", () => {
    const id = generateProjectId("/home/user/My App/", "linux");

    expect(id).toMatch(/^My-App-[0-9a-f]{8}$/);
    expect(generateProjectId("/home/user//My App", "linux")).toBe(id);
  });

  it("case-folds on Windows only, whose paths are case-insensitive", () => {
    expect(generateProjectId("/Users/Dev/App", "win32")).toBe(
      generateProjectId("/users/dev/app", "win32")
    );
    expect(generateProjectId("/Users/Dev/App", "linux")).not.toBe(
      generateProjectId("/users/dev/app", "linux")
    );
  });
});
