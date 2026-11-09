/**
 * A real core workspace registry over an in-memory filesystem, for tests of
 * modules that read and write workspace metadata through it.
 */

import { createFileSystemMock, directory } from "../boundaries/platform/filesystem.state-mock";
import type { MockFileSystemBoundary } from "../boundaries/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { projectPathSchema } from "../intents/contract";
import { testPath } from "../shared/test-fixtures";
import { Path } from "../utils/path/path";
import { gitProjectRef } from "./git/ref";
import {
  createWorkspaceRegistryModule,
  type WorkspaceRegistryModule,
} from "./workspace-registry-module";

/** Where the test registry keeps every project's metadata files (the project store's record dirs). */
export const TEST_PROJECTS_DIR = testPath("/data/projects");

/** The record directory the test registry gives every project. */
export const TEST_PROJECT_DIR = new Path(TEST_PROJECTS_DIR, "project");

/** An in-memory filesystem with {@link TEST_PROJECTS_DIR} in place, for metadata files to go to. */
export const createTestMetadataFs = (): MockFileSystemBoundary =>
  createFileSystemMock({ entries: { [TEST_PROJECTS_DIR.toString()]: directory() } });

export function createTestWorkspaceRegistry(fs: MockFileSystemBoundary = createTestMetadataFs()): {
  registry: WorkspaceRegistryModule;
  fs: MockFileSystemBoundary;
} {
  const registry = createWorkspaceRegistryModule({
    fs,
    logger: SILENT_LOGGER,
    projectDir: () => TEST_PROJECT_DIR,
  });
  return { registry, fs };
}

/**
 * Make the registry hold the workspace at `workspacePath` of `projectPath`, with
 * `metadata`; its file goes where the registry places files a type names no
 * location for.
 */
export async function holdTestWorkspace(
  registry: WorkspaceRegistryModule,
  projectPath: Path,
  workspacePath: Path,
  metadata: Readonly<Record<string, string>> = {}
): Promise<void> {
  const project = {
    ref: gitProjectRef(projectPath.toString()),
    path: projectPathSchema.parse(projectPath.toString()),
  };
  await registry.track(project, {
    name: workspacePath.basename,
    path: workspacePath,
    branch: null,
    metadata,
  });
}
