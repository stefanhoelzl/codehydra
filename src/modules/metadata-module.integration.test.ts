// @vitest-environment node
/**
 * Integration tests for MetadataModule through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook -> registry,
 * using the real core workspace registry on an in-memory filesystem.
 *
 * The module under test is createMetadataModule (the extracted hook handler).
 * Resolve-project and resolve-workspace are inline stubs.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { SetMetadataOperation, INTENT_SET_METADATA } from "../intents/set-metadata";
import type { SetMetadataIntent } from "../intents/set-metadata";
import { GetMetadataOperation, INTENT_GET_METADATA } from "../intents/get-metadata";
import type { GetMetadataIntent } from "../intents/get-metadata";
import { registerTestInfrastructure } from "../intents/operations.test-utils";
import { createMetadataModule } from "./metadata-module";
import { createTestWorkspaceRegistry, holdTestWorkspace } from "./workspace-registry.test-utils";
import { Path } from "../utils/path/path";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import { projPath, testPath, workspaceRefIn } from "../shared/test-fixtures";
import type { WorkspaceRef } from "../intents/contract";

// =============================================================================
// Test Constants
// =============================================================================

const PROJECT_ROOT = testPath("/project");
const WORKSPACES_DIR = testPath("/workspaces");

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  projectId: ProjectId;
  workspaceName: WorkspaceName;
  workspaceRef: WorkspaceRef;
}

async function createTestSetup(): Promise<TestSetup> {
  const workspacePath = new Path(WORKSPACES_DIR, "feature-x");
  const { registry } = createTestWorkspaceRegistry();
  await holdTestWorkspace(registry, PROJECT_ROOT, workspacePath);

  const projectId = "project-ea0135bc" as ProjectId;
  const workspaceName = "feature-x" as WorkspaceName;

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new SetMetadataOperation());
  dispatcher.registerOperation(new GetMetadataOperation());

  registerTestInfrastructure(dispatcher, {
    workspaces: {
      [workspacePath.toString()]: { projectPath: projPath(PROJECT_ROOT.toString()), workspaceName },
    },
    projects: { [PROJECT_ROOT.toString()]: { projectId } },
  });

  // Module under test
  const metadataModule = createMetadataModule({ registry });
  dispatcher.registerModule(metadataModule);

  return {
    dispatcher,
    projectId,
    workspaceName,
    workspaceRef: workspaceRefIn(PROJECT_ROOT.toString(), workspaceName),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MetadataModule Integration", () => {
  it("set then get returns correct metadata (round-trip)", async () => {
    const { dispatcher, workspaceRef } = await createTestSetup();

    const setIntent: SetMetadataIntent = {
      type: INTENT_SET_METADATA,
      payload: { workspaceRef, key: "description", value: "my workspace" },
    };
    await dispatcher.dispatch(setIntent);

    const getIntent: GetMetadataIntent = {
      type: INTENT_GET_METADATA,
      payload: { workspaceRef },
    };
    const metadata = await dispatcher.dispatch(getIntent);

    expect(metadata).toMatchObject({ description: "my workspace" });
  });

  it("set with null value deletes key", async () => {
    const { dispatcher, workspaceRef } = await createTestSetup();

    // Set a value first
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { workspaceRef, key: "description", value: "to be deleted" },
    } satisfies SetMetadataIntent);

    // Delete it
    await dispatcher.dispatch({
      type: INTENT_SET_METADATA,
      payload: { workspaceRef, key: "description", value: null },
    } satisfies SetMetadataIntent);

    // Get should not contain the deleted key
    const metadata = await dispatcher.dispatch({
      type: INTENT_GET_METADATA,
      payload: { workspaceRef },
    } satisfies GetMetadataIntent);

    expect(metadata).not.toHaveProperty("description");
  });
});
