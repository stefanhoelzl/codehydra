// @vitest-environment node
/**
 * Integration tests for MigrationModule.
 *
 * Tests verify the one-time migration of old-layout cloned projects.
 *
 * Test plan items covered:
 * #1: migrates old-layout cloned project to new layout
 * #2: no-op when remotesDir is undefined
 * #3: no-op when no configs have remoteUrl
 * #4: migration failure for one project doesn't block others
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { createMigrationModule, type MigrationModuleDeps } from "./migration-module";
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";
import type { AppStartIntent } from "../operations/app-start";
import { Path } from "../../services/platform/path";
import type { ResolvedHooks } from "../intents/infrastructure/operation";
import { createFileSystemMock, directory } from "../../services/platform/filesystem.state-mock";
import { CURRENT_PROJECT_VERSION } from "../../services/project/types";
import { projectDirName } from "../../services/platform/paths";
import nodePath from "path";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECTS_DIR = "/test/app-data/projects";
const REMOTES_DIR = "/test/app-data/remotes";

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  startHooks: ResolvedHooks;
  fs: ReturnType<typeof createFileSystemMock>;
}

function createTestSetup(
  remotesDir: string | undefined,
  fsOverrides?: Parameters<typeof createFileSystemMock>[0]
): TestSetup {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  const fs = createFileSystemMock({
    entries: {
      [PROJECTS_DIR]: directory(),
      ...(fsOverrides?.entries ?? {}),
    },
  });

  const deps: MigrationModuleDeps = {
    projectsDir: PROJECTS_DIR,
    remotesDir,
    fs,
  };

  const module = createMigrationModule(deps);
  dispatcher.registerModule(module);

  return {
    startHooks: hookRegistry.resolve(APP_START_OPERATION_ID),
    fs,
  };
}

// =============================================================================
// Intent Helpers
// =============================================================================

function appStartIntent(): AppStartIntent {
  return {
    type: "app:start",
    payload: {} as AppStartIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MigrationModule Integration", () => {
  it("migrates old-layout cloned project to new layout (#1)", async () => {
    const setup = createTestSetup(REMOTES_DIR);

    // Set up old-layout cloned project:
    // projects/<url-hash>/config.json with remoteUrl + repo directory
    const remoteUrl = "https://github.com/org/migrated-repo.git";
    const urlHash = "migrated-repo-oldlayout"; // simulated url-hash dir name
    const oldConfigDir = nodePath.join(PROJECTS_DIR, urlHash);
    const oldRepoDir = nodePath.join(oldConfigDir, "migrated-repo");
    const oldConfig = {
      version: CURRENT_PROJECT_VERSION,
      path: nodePath.join(oldConfigDir, "migrated-repo"),
      remoteUrl,
    };

    // Create old layout entries
    setup.fs.$.setEntry(oldConfigDir, { type: "directory" });
    setup.fs.$.setEntry(nodePath.join(oldConfigDir, "config.json"), {
      type: "file",
      content: JSON.stringify(oldConfig),
    });
    setup.fs.$.setEntry(oldRepoDir, { type: "directory" });

    // Run activate — migration should move repo dir to remotes/
    const { results, errors } = await setup.startHooks.collect<ActivateHookResult>("activate", {
      intent: appStartIntent(),
    });

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(1);
    // Migration module returns empty projectPaths
    expect(results[0]).toEqual({});

    // Verify old dir was moved to remotes/
    const newDir = nodePath.join(REMOTES_DIR, urlHash);
    expect(setup.fs.$.entries.has(new Path(newDir).toString())).toBe(true);

    // Verify new config was written at path-hashed location
    const newProjectPath = new Path(newDir, "migrated-repo").toString();
    const expectedDirName = projectDirName(newProjectPath);
    const newConfigPath = nodePath.join(PROJECTS_DIR, expectedDirName, "config.json");
    const entry = setup.fs.$.entries.get(new Path(newConfigPath).toString());
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("file");
    const config = JSON.parse((entry as { content: string }).content);
    expect(config.remoteUrl).toBe(remoteUrl);
    expect(config.path).toBe(newProjectPath);
  });

  it("no-op when remotesDir is undefined (#2)", async () => {
    const setup = createTestSetup(undefined);

    // Add a config with remoteUrl — should NOT be migrated
    const urlHash = "some-repo";
    const configDir = nodePath.join(PROJECTS_DIR, urlHash);
    const config = {
      version: CURRENT_PROJECT_VERSION,
      path: nodePath.join(configDir, "repo"),
      remoteUrl: "https://github.com/org/repo.git",
    };
    setup.fs.$.setEntry(configDir, { type: "directory" });
    setup.fs.$.setEntry(nodePath.join(configDir, "config.json"), {
      type: "file",
      content: JSON.stringify(config),
    });

    const { results, errors } = await setup.startHooks.collect<ActivateHookResult>("activate", {
      intent: appStartIntent(),
    });

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({});

    // Old dir should still exist (no migration occurred)
    expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(true);
  });

  it("no-op when no configs have remoteUrl (#3)", async () => {
    const setup = createTestSetup(REMOTES_DIR);

    // Add a local project config (no remoteUrl)
    const projectPath = "/test/local-project";
    const dirName = projectDirName(new Path(projectPath).toString());
    const configDir = nodePath.join(PROJECTS_DIR, dirName);
    const config = {
      version: CURRENT_PROJECT_VERSION,
      path: new Path(projectPath).toString(),
    };
    setup.fs.$.setEntry(configDir, { type: "directory" });
    setup.fs.$.setEntry(nodePath.join(configDir, "config.json"), {
      type: "file",
      content: JSON.stringify(config),
    });

    const { results, errors } = await setup.startHooks.collect<ActivateHookResult>("activate", {
      intent: appStartIntent(),
    });

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({});

    // Config should still be in original location
    expect(setup.fs.$.entries.has(new Path(configDir).toString())).toBe(true);
  });

  it("migration failure for one project doesn't block others (#4)", async () => {
    const setup = createTestSetup(REMOTES_DIR);

    // First project: will fail (rename will fail because newDir already exists as a file)
    const urlHash1 = "repo-one-oldhash";
    const oldConfigDir1 = nodePath.join(PROJECTS_DIR, urlHash1);
    const config1 = {
      version: CURRENT_PROJECT_VERSION,
      path: nodePath.join(oldConfigDir1, "repo-one"),
      remoteUrl: "https://github.com/org/repo-one.git",
    };
    setup.fs.$.setEntry(oldConfigDir1, { type: "directory" });
    setup.fs.$.setEntry(nodePath.join(oldConfigDir1, "config.json"), {
      type: "file",
      content: JSON.stringify(config1),
    });
    // Block migration by making the target path a file (rename will fail)
    setup.fs.$.setEntry(REMOTES_DIR, { type: "directory" });
    const targetDir1 = nodePath.join(REMOTES_DIR, urlHash1);
    setup.fs.$.setEntry(targetDir1, { type: "file", content: "" });

    // Second project: should succeed
    const urlHash2 = "repo-two-oldhash";
    const oldConfigDir2 = nodePath.join(PROJECTS_DIR, urlHash2);
    const config2 = {
      version: CURRENT_PROJECT_VERSION,
      path: nodePath.join(oldConfigDir2, "repo-two"),
      remoteUrl: "https://github.com/org/repo-two.git",
    };
    setup.fs.$.setEntry(oldConfigDir2, { type: "directory" });
    setup.fs.$.setEntry(nodePath.join(oldConfigDir2, "config.json"), {
      type: "file",
      content: JSON.stringify(config2),
    });

    const { results, errors } = await setup.startHooks.collect<ActivateHookResult>("activate", {
      intent: appStartIntent(),
    });

    // Should not throw — migration is best-effort
    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(1);

    // Second project should have been migrated
    const newDir2 = nodePath.join(REMOTES_DIR, urlHash2);
    expect(setup.fs.$.entries.has(new Path(newDir2).toString())).toBe(true);
  });
});
