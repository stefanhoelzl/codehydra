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

function registry() {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
    },
    SILENT_LOGGER
  );
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
