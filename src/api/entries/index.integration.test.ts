// @vitest-environment node
/**
 * Conformance tests for the registry's contents.
 *
 * These assert the invariants that make "one registry, many adapters" true
 * rather than aspirational: the vocabulary and the entries agree exactly, and
 * every entry is documented well enough for an adapter to present it.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createRegistry } from "./index";
import { OPERATION_NAMES } from "../names";
import type { AnyOperationEntry } from "../types";
import { schemas as openWorkspaceSchemas } from "../../intents/open-workspace";
import { workspaceSchema, type AgentSpec } from "../../intents/contract";
import type { Dispatcher } from "../../intents/lib/dispatcher";

function registry(dispatcher: Dispatcher = createMockDispatcher()) {
  return createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
    },
    SILENT_LOGGER
  );
}

/**
 * Run `workspace.create` far enough to see the AgentSpec it builds.
 *
 * The projection from flat input onto the contract's discriminated union is the
 * behaviour under test, and it is only observable in the dispatched payload —
 * so stand in a recording operation for `workspace:open` and read it back.
 */
async function createdAgentSpec(
  input: Record<string, unknown>
): Promise<AgentSpec | undefined | "not-dispatched"> {
  const dispatcher = createMockDispatcher();
  let seen: AgentSpec | undefined | "not-dispatched" = "not-dispatched";
  dispatcher.registerOperation({
    id: "recording-open-workspace",
    schemas: openWorkspaceSchemas,
    execute: async (ctx) => {
      seen = ctx.intent.payload.agent;
      // The dispatcher validates the result, so it has to be a real Workspace —
      // parsed rather than cast, so the branded fields are branded.
      return workspaceSchema.parse({
        projectId: "p",
        name: "w",
        branch: "w",
        metadata: {},
        path: "/p/w",
      });
    },
  });
  const create = registry(dispatcher).get("workspace.create");
  // `project` explicitly, so the handler skips resolving one from the caller.
  await create.handler(
    { workspacePath: null, cwd: null },
    // The entry's own schema is what an adapter feeds the handler.
    create.input.parse({ name: "w", project: "/p", ...input })
  );
  return seen;
}

const entries = (): readonly AnyOperationEntry[] => registry().all();

describe("registry contents", () => {
  it("implements exactly the operation vocabulary", () => {
    // Both directions: an entry with no name in the vocabulary, or a name with
    // no entry, would let an exhaustive adapter map compile and then fail at
    // runtime.
    expect([...entries().map((e) => e.name)].sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("gives every entry a one-line description", () => {
    for (const entry of entries()) {
      expect(entry.description, entry.name).toBeTruthy();
      expect(entry.description, entry.name).not.toContain("\n");
    }
  });

  it("has exactly one event", () => {
    const events = entries().filter((e) => e.kind === "event");
    expect(events.map((e) => e.name)).toEqual(["agent.lifecycle"]);
  });

  describe("divergence resolutions", () => {
    it("defaults keepBranch to false", () => {
      const del = registry().get("workspace.delete");
      expect((del.input.parse({}) as { keepBranch: boolean }).keepBranch).toBe(false);
    });

    it("defaults delete to blocking", () => {
      const del = registry().get("workspace.delete");
      expect((del.input.parse({}) as { wait: boolean }).wait).toBe(true);
    });

    it("makes projectPath optional on create", () => {
      const create = registry().get("workspace.create");
      expect(create.input.safeParse({ name: "x", base: "main" }).success).toBe(true);
    });

    it("makes base optional on create", () => {
      // The worktree module falls back to the project's default branch — the
      // same default the creation panel offers — so requiring it here would
      // make `ch ws create foo` fail for no reason.
      const create = registry().get("workspace.create");
      expect(create.input.safeParse({ name: "x" }).success).toBe(true);
    });

    it("accepts agent and model on create", () => {
      const create = registry().get("workspace.create");
      const parsed = create.input.safeParse({
        name: "x",
        base: "main",
        prompt: "go",
        agent: "claude",
        model: "opus",
      });
      expect(parsed.success).toBe(true);
    });
  });

  /**
   * The creation panel emits a backend-specific AgentSpec arm; every other
   * surface goes through this entry, so the two must offer the same options.
   */
  describe("create builds the same AgentSpec the creation panel does", () => {
    it("carries every claude option onto the claude arm", async () => {
      await expect(
        createdAgentSpec({
          prompt: "go",
          agent: "claude",
          model: "anthropic/claude-sonnet-4-5",
          permissionMode: "bypassPermissions",
          agentName: "reviewer",
        })
      ).resolves.toEqual({
        type: "claude",
        prompt: "go",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        permissionMode: "bypassPermissions",
        agentName: "reviewer",
      });
    });

    it("carries the opencode options onto the opencode arm", async () => {
      await expect(
        createdAgentSpec({ prompt: "go", agent: "opencode", model: "mock/test" })
      ).resolves.toEqual({
        type: "opencode",
        prompt: "go",
        model: { providerID: "mock", modelID: "test" },
      });
    });

    it("takes a bare model id for claude, which reads only the id", async () => {
      await expect(createdAgentSpec({ agent: "claude", model: "opus" })).resolves.toEqual({
        type: "claude",
        model: { providerID: "anthropic", modelID: "opus" },
      });
    });

    it("still emits the option-less default arm for a bare prompt", async () => {
      await expect(createdAgentSpec({ prompt: "go" })).resolves.toEqual({
        type: "default",
        prompt: "go",
      });
    });

    it("dispatches no agent at all when nothing about one was asked for", async () => {
      await expect(createdAgentSpec({})).resolves.toBeUndefined();
    });

    it("rejects an option that needs a backend when none was named", async () => {
      // Silently dropping these is what made the CLI poorer than the panel.
      await expect(createdAgentSpec({ permissionMode: "plan" })).rejects.toThrow(
        /needs an agent backend/
      );
    });

    it("rejects a claude-only option on opencode", async () => {
      await expect(createdAgentSpec({ agent: "opencode", permissionMode: "plan" })).rejects.toThrow(
        /Claude option/
      );
    });

    it("rejects an unknown backend rather than falling back to default", async () => {
      await expect(createdAgentSpec({ agent: "claud", prompt: "go" })).rejects.toThrow(
        /Unknown agent "claud"/
      );
    });

    it("rejects a provider-less model for opencode, which cannot guess one", async () => {
      await expect(createdAgentSpec({ agent: "opencode", model: "test" })).rejects.toThrow(
        /provider\/model/
      );
    });

    it("lets app-global entries run without a workspace", () => {
      const global = entries()
        .filter((e) => !e.requiresWorkspace)
        .map((e) => e.name)
        .sort();
      // These name their own target, or need none, so they work from a shell
      // standing anywhere — including outside every worktree.
      expect(global).toEqual([
        "log",
        "project.close",
        "project.list",
        "project.open",
        "report.issue",
        "system.open",
        "workspace.create",
        "workspace.switch",
      ]);
    });
  });
});
