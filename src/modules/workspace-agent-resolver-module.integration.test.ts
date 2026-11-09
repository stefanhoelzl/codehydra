// @vitest-environment node
/**
 * Integration tests for the workspace agent resolver: what it records in a
 * workspace's metadata when the workspace opens, over a real core workspace
 * registry on an in-memory filesystem.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_OPEN_WORKSPACE, OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import type { Intent } from "../intents/lib/types";
import { createWorkspaceAgentResolverModule } from "./workspace-agent-resolver-module";
import { createTestWorkspaceRegistry, holdTestWorkspace } from "./workspace-registry.test-utils";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { testPath } from "../shared/test-fixtures";
import { Path } from "../utils/path/path";

const PROJECT_ROOT = testPath("/project");
const WORKSPACES_DIR = testPath("/workspaces");
const FEATURE = new Path(WORKSPACES_DIR, "feature-x");

async function setup(defaultAgent: ConfigAgentType, metadata: Record<string, string> = {}) {
  const { registry } = createTestWorkspaceRegistry();
  await holdTestWorkspace(registry, PROJECT_ROOT, FEATURE, metadata);

  const agentConfig = createMockAccessor<ConfigAgentType>("agent", defaultAgent);
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(
    createMinimalOperation(OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE, "setup", {
      hookContext: (ctx) => ({ intent: ctx.intent, workspacePath: FEATURE.toString() }),
    })
  );
  dispatcher.registerModule(
    createWorkspaceAgentResolverModule({
      registry,
      agentConfig,
      logger: SILENT_LOGGER,
    })
  );

  const open = async (agent?: string): Promise<void> => {
    await dispatcher.dispatch({
      type: INTENT_OPEN_WORKSPACE,
      payload: agent ? { agent: { type: agent } } : {},
    } as Intent);
  };

  return { open, registry, agentConfig };
}

describe("WorkspaceAgentResolver on open", () => {
  it("records the default agent, so a later default change leaves the workspace alone", async () => {
    const { open, registry, agentConfig } = await setup("claude");

    await open();
    expect(registry.metadata(FEATURE).agent).toBe("claude");

    await agentConfig.set("opencode");
    await open();
    expect(registry.metadata(FEATURE).agent).toBe("claude");
  });

  it("records a requested agent over the default", async () => {
    const { open, registry } = await setup("claude");

    await open("opencode");

    expect(registry.metadata(FEATURE).agent).toBe("opencode");
  });

  it("keeps the agent already recorded", async () => {
    const { open, registry } = await setup("claude", { agent: "opencode" });

    await open();

    expect(registry.metadata(FEATURE).agent).toBe("opencode");
  });
});
