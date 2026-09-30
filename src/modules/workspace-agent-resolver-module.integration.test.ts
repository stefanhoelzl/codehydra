// @vitest-environment node
/**
 * Integration tests for the workspace agent resolver: what it records in a
 * workspace's metadata when the workspace opens, over a real GitWorktreeProvider
 * with behavioral mocks.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_OPEN_WORKSPACE, OPEN_WORKSPACE_OPERATION_ID } from "../intents/open-workspace";
import type { Intent } from "../intents/lib/types";
import { createWorkspaceAgentResolverModule } from "./workspace-agent-resolver-module";
import { createMockGitClient } from "../boundaries/platform/git-client.state-mock";
import { createFileSystemMock } from "../boundaries/platform/filesystem.state-mock";
import { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { testPath } from "../shared/test-fixtures";
import { Path } from "../utils/path/path";

const PROJECT_ROOT = testPath("/project");
const WORKSPACES_DIR = testPath("/workspaces");
const FEATURE = new Path(WORKSPACES_DIR, "feature-x");

async function setup(defaultAgent: ConfigAgentType, metadata: Record<string, string> = {}) {
  const fs = createFileSystemMock();
  const gitClient = createMockGitClient({
    fileSystem: fs,
    repositories: {
      [PROJECT_ROOT.toString()]: {
        branches: ["main", "feature-x"],
        currentBranch: "main",
        worktrees: [{ name: "feature-x", path: FEATURE.toString(), branch: "feature-x" }],
      },
    },
  });
  const provider = new GitWorktreeProvider(gitClient, fs, SILENT_LOGGER);
  provider.registerProject(PROJECT_ROOT, WORKSPACES_DIR);
  await provider.discover(PROJECT_ROOT);
  for (const [key, value] of Object.entries(metadata)) {
    await provider.setMetadata(FEATURE, key, value);
  }

  const agentConfig = createMockAccessor<ConfigAgentType>("agent", defaultAgent);
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(
    createMinimalOperation(OPEN_WORKSPACE_OPERATION_ID, INTENT_OPEN_WORKSPACE, "setup", {
      hookContext: (ctx) => ({ intent: ctx.intent, workspacePath: FEATURE.toString() }),
    })
  );
  dispatcher.registerModule(
    createWorkspaceAgentResolverModule({
      gitWorktreeProvider: provider,
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

  return { open, provider, agentConfig };
}

describe("WorkspaceAgentResolver on open", () => {
  it("records the default agent, so a later default change leaves the workspace alone", async () => {
    const { open, provider, agentConfig } = await setup("claude");

    await open();
    expect((await provider.getMetadata(FEATURE)).agent).toBe("claude");

    await agentConfig.set("opencode");
    await open();
    expect((await provider.getMetadata(FEATURE)).agent).toBe("claude");
  });

  it("records a requested agent over the default", async () => {
    const { open, provider } = await setup("claude");

    await open("opencode");

    expect((await provider.getMetadata(FEATURE)).agent).toBe("opencode");
  });

  it("keeps the agent already recorded", async () => {
    const { open, provider } = await setup("claude", { agent: "opencode" });

    await open();

    expect((await provider.getMetadata(FEATURE)).agent).toBe("opencode");
  });
});
